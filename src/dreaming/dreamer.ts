import {
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LLMProvider } from '../llm/provider.js';
import type {
  DreamPattern,
  DreamResult,
  DreamHistoryEntry,
  MemorySnapshot,
  SessionTranscript,
} from './types.js';
import { readSessions } from './transcripts.js';
import { readMemory, applyMemorySnapshot } from './memory-store.js';
import { readPatternsFile, writePatternsFile } from './patterns.js';
import {
  buildDreamPrompt,
  parseDreamResponse,
  DREAM_SYSTEM_PROMPT,
} from './prompts.js';
import { readRecentWins } from './wins.js';
import { DreamHistory } from './history.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface DreamerOptions {
  /** Kultiv project directory (typically `.kultiv/`). */
  evoDir: string;
  /** Memory tier to consolidate. */
  memoryDir: string;
  /** Where Claude Code session transcripts live. */
  sessionsDir: string;
  /** Path to Kultiv archive — used to surface recent mutation wins. */
  archivePath: string;
  /** LLM provider configured for the dreaming model. */
  provider: LLMProvider;
  /** Display name of the model — recorded in history & rendered in patterns. */
  modelId: string;
  /** USD per million input tokens — for cost estimation. */
  inputCostPerMTok?: number;
  /** USD per million output tokens — for cost estimation. */
  outputCostPerMTok?: number;
  /** Max number of session transcripts to feed to the LLM. */
  maxSessions?: number;
  /** Lookback window for session selection. */
  withinDays?: number;
  /** Optional user-supplied focus instructions. */
  instructions?: string;
}

export interface RunDreamOptions {
  /** Skip the cooldown check. Default false. */
  force?: boolean;
  /** Auto-apply if the dream completes without errors. Default false. */
  autoApply?: boolean;
  /** Hours since last completed dream before another can run. Default 6. */
  cooldownHours?: number;
}

export interface RunDreamOutcome {
  result: DreamResult;
  applied: boolean;
  skipped?: 'cooldown' | 'no-memory' | 'no-sessions';
}

// ── Public API ──────────────────────────────────────────────────────────

export async function runDream(
  opts: DreamerOptions,
  runOpts: RunDreamOptions = {},
): Promise<RunDreamOutcome> {
  const dreamId = makeDreamId();
  const startedAt = new Date().toISOString();

  const dreamsDir = join(opts.evoDir, 'dreams');
  ensureDir(dreamsDir);
  const historyPath = join(dreamsDir, 'history.jsonl');
  const history = new DreamHistory(historyPath);

  // Cooldown check (skipped on --force).
  if (!runOpts.force) {
    const last = history.lastCompletedAt();
    if (last) {
      const cooldownHours = runOpts.cooldownHours ?? 6;
      const hoursSince = (Date.now() - last.getTime()) / 3_600_000;
      if (hoursSince < cooldownHours) {
        return {
          result: makeFailureResult(dreamId, startedAt, opts.modelId, [], `cooldown ${cooldownHours}h not elapsed (${hoursSince.toFixed(1)}h since last dream)`),
          applied: false,
          skipped: 'cooldown',
        };
      }
    }
  }

  const snapshot = readMemory(opts.memoryDir);
  if (!snapshot) {
    const result = makeFailureResult(dreamId, startedAt, opts.modelId, [], `no memory tier at ${opts.memoryDir}`);
    history.append(toHistoryEntry(result, snapshot, []));
    return { result, applied: false, skipped: 'no-memory' };
  }

  const sessions = readSessions(opts.sessionsDir, {
    limit: opts.maxSessions ?? 20,
    withinDays: opts.withinDays ?? 14,
  });
  if (sessions.length === 0) {
    const result = makeFailureResult(dreamId, startedAt, opts.modelId, [], `no recent sessions in ${opts.sessionsDir}`);
    history.append(toHistoryEntry(result, snapshot, sessions));
    return { result, applied: false, skipped: 'no-sessions' };
  }

  const previousPatterns = readPatternsFile(join(dreamsDir, 'patterns.md'));
  const recentWins = readRecentWins(opts.archivePath, 20);

  const prompt = buildDreamPrompt({
    snapshot,
    sessions,
    previousPatterns,
    recentWins,
    instructions: opts.instructions,
  });

  let llmResponse: string;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const resp = await opts.provider.generate(
      [{ role: 'user', content: `${DREAM_SYSTEM_PROMPT}\n\n${prompt}` }],
      { maxTokens: 16000, temperature: 0.3 },
    );
    llmResponse = resp.content;
    inputTokens = resp.input_tokens;
    outputTokens = resp.output_tokens;
  } catch (err) {
    const result = makeFailureResult(dreamId, startedAt, opts.modelId, [], `LLM call failed: ${String(err)}`);
    history.append(toHistoryEntry(result, snapshot, sessions));
    return { result, applied: false };
  }

  const parsed = parseDreamResponse(llmResponse);
  const completedAt = new Date().toISOString();
  const cost = estimateCost(inputTokens, outputTokens, opts.inputCostPerMTok, opts.outputCostPerMTok);

  // Persist proposal artifacts regardless of errors — useful for debugging.
  const proposalDir = join(dreamsDir, 'proposed', dreamId);
  ensureDir(proposalDir);

  const proposedMemoryPath = join(proposalDir, 'MEMORY.md');
  if (parsed.newIndex) writeFileSync(proposedMemoryPath, parsed.newIndex, 'utf-8');

  const proposedPatternsPath = join(proposalDir, 'patterns.md');
  writePatternsFile(proposedPatternsPath, parsed.patterns, {
    generatedAt: completedAt,
    sessionCount: sessions.length,
    modelId: opts.modelId,
  });

  for (const tf of parsed.topicFiles) {
    const safeName = sanitizeRelativePath(tf.relativePath);
    if (!safeName) continue;
    const target = join(proposalDir, safeName);
    ensureDir(dirOf(target));
    writeFileSync(target, tf.content, 'utf-8');
  }

  const summaryPath = join(proposalDir, 'summary.md');
  writeFileSync(
    summaryPath,
    buildSummaryMarkdown({
      dreamId,
      startedAt,
      completedAt,
      modelId: opts.modelId,
      sessions,
      patterns: parsed.patterns,
      summary: parsed.summary,
      errors: parsed.errors,
      cost,
      inputTokens,
      outputTokens,
    }),
    'utf-8',
  );

  // Also raw response for debugging.
  writeFileSync(join(proposalDir, 'response.txt'), llmResponse, 'utf-8');

  const status: DreamResult['status'] = parsed.errors.length === 0 ? 'completed' : 'failed';

  const result: DreamResult = {
    id: dreamId,
    status,
    startedAt,
    completedAt,
    model: opts.modelId,
    inputSessionIds: sessions.map((s) => s.sessionId),
    inputTokens,
    outputTokens,
    estimatedCostUsd: cost,
    proposedMemoryPath,
    proposedPatternsPath,
    summaryPath,
    patterns: parsed.patterns,
    error: parsed.errors.length > 0 ? parsed.errors.join('; ') : undefined,
  };

  // Always update the active patterns.md (even on partial success) so the
  // mutation engine has the latest cross-session signals.
  if (parsed.patterns.length > 0) {
    writePatternsFile(join(dreamsDir, 'patterns.md'), parsed.patterns, {
      generatedAt: completedAt,
      sessionCount: sessions.length,
      modelId: opts.modelId,
    });
  }

  history.append(toHistoryEntry(result, snapshot, sessions));

  let applied = false;
  if (status === 'completed' && runOpts.autoApply) {
    applyDream(opts, result, /* dreamsDir */ dreamsDir);
    history.markApplied(dreamId, new Date().toISOString());
    applied = true;
  }

  return { result, applied };
}

/**
 * Apply a previously-proposed dream to the live memory tier. Backups are
 * written to `<memoryDir>/.dreams/backups/<timestamp>/`. Returns the list of
 * files written.
 */
export function applyDream(
  opts: Pick<DreamerOptions, 'memoryDir' | 'evoDir'>,
  result: DreamResult,
  dreamsDir?: string,
): string[] {
  if (!result.proposedMemoryPath || !existsSync(result.proposedMemoryPath)) {
    throw new Error(`proposed MEMORY.md not found for dream ${result.id}`);
  }
  const newIndex = readFileSync(result.proposedMemoryPath, 'utf-8');

  const proposalDir = result.proposedMemoryPath.replace(/[/\\]MEMORY\.md$/, '');
  const topicFiles = collectTopicFilesFromProposalDir(proposalDir);

  const written = applyMemorySnapshot(opts.memoryDir, { indexContent: newIndex, topicFiles });

  // Move proposal to accepted/.
  const acceptedDir = join(dreamsDir ?? join(opts.evoDir, 'dreams'), 'accepted', result.id);
  movePropProposal(proposalDir, acceptedDir);

  return written;
}

/**
 * Reject a previously-proposed dream — moves it from `proposed/` to
 * `rejected/` so the diff and patterns are preserved for review.
 */
export function rejectDream(
  opts: Pick<DreamerOptions, 'evoDir'>,
  result: DreamResult,
  dreamsDir?: string,
): string {
  const dreams = dreamsDir ?? join(opts.evoDir, 'dreams');
  if (!result.proposedMemoryPath) throw new Error(`no proposal directory for dream ${result.id}`);
  const proposalDir = result.proposedMemoryPath.replace(/[/\\]MEMORY\.md$/, '');
  const target = join(dreams, 'rejected', result.id);
  movePropProposal(proposalDir, target);
  return target;
}

// ── Internal helpers ────────────────────────────────────────────────────

function makeFailureResult(
  id: string,
  startedAt: string,
  model: string,
  patterns: DreamPattern[],
  error: string,
): DreamResult {
  return {
    id,
    status: 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    model,
    inputSessionIds: [],
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    proposedMemoryPath: null,
    proposedPatternsPath: null,
    summaryPath: null,
    patterns,
    error,
  };
}

function toHistoryEntry(
  r: DreamResult,
  snap: MemorySnapshot | null,
  sessions: SessionTranscript[],
): DreamHistoryEntry {
  return {
    id: r.id,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    status: r.status,
    model: r.model,
    sessionCount: sessions.length,
    patternCount: r.patterns.length,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    estimatedCostUsd: r.estimatedCostUsd,
    applied: false,
    appliedAt: null,
    error: r.error,
  };
}

function makeDreamId(): string {
  const d = new Date();
  const slug = d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `dream-${slug}`;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function dirOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(0, slash) : '.';
}

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  inputCostPerMTok = 3,
  outputCostPerMTok = 15,
): number {
  const cost = (inputTokens / 1_000_000) * inputCostPerMTok + (outputTokens / 1_000_000) * outputCostPerMTok;
  return +cost.toFixed(4);
}

function sanitizeRelativePath(rel: string): string | null {
  // No path traversal; strip leading separators; only allow .md files in
  // top-level (Kultiv memory tier is flat).
  const cleaned = rel.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  if (cleaned.includes('..') || cleaned.includes('/')) return null;
  if (!cleaned.endsWith('.md')) return null;
  return cleaned;
}

function collectTopicFilesFromProposalDir(
  proposalDir: string,
): Array<{ relativePath: string; content: string }> {
  // Flat — we never write nested in proposal anyway.
  const out: Array<{ relativePath: string; content: string }> = [];
  if (!existsSync(proposalDir)) return out;
  for (const entry of readdirSync(proposalDir)) {
    if (!entry.endsWith('.md')) continue;
    if (entry === 'MEMORY.md' || entry === 'patterns.md' || entry === 'summary.md') continue;
    const full = join(proposalDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      relativePath: entry,
      content: readFileSync(full, 'utf-8'),
    });
  }
  return out;
}

function movePropProposal(from: string, to: string): void {
  if (!existsSync(from)) return;
  ensureDir(to);
  for (const entry of readdirSync(from)) {
    try {
      copyFileSync(join(from, entry), join(to, entry));
    } catch {
      // best effort — proposal artifacts are debug aids, not load-bearing
    }
  }
  try {
    rmSync(from, { recursive: true, force: true });
  } catch {
    // leave it; the data is already mirrored to `to`
  }
}

function buildSummaryMarkdown(args: {
  dreamId: string;
  startedAt: string;
  completedAt: string;
  modelId: string;
  sessions: SessionTranscript[];
  patterns: DreamPattern[];
  summary: string;
  errors: string[];
  cost: number;
  inputTokens: number;
  outputTokens: number;
}): string {
  const lines = [
    `# Dream Summary — ${args.dreamId}`,
    '',
    `- Started: ${args.startedAt}`,
    `- Completed: ${args.completedAt}`,
    `- Model: ${args.modelId}`,
    `- Sessions consumed: ${args.sessions.length}`,
    `- Patterns surfaced: ${args.patterns.length}`,
    `- Tokens: in=${args.inputTokens}, out=${args.outputTokens}`,
    `- Est. cost: $${args.cost.toFixed(4)}`,
    '',
  ];
  if (args.errors.length > 0) {
    lines.push('## Errors');
    for (const e of args.errors) lines.push(`- ${e}`);
    lines.push('');
  }
  if (args.summary) {
    lines.push('## LLM Summary');
    lines.push(args.summary);
    lines.push('');
  }
  if (args.patterns.length > 0) {
    lines.push('## Patterns Surfaced');
    for (const p of args.patterns) {
      lines.push(`- **[${p.severity}/${p.category}] ${p.id} — ${p.title}** (targets: ${p.targetArtifacts.join(', ') || 'n/a'})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
