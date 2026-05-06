import type { DreamPattern, MemorySnapshot, SessionTranscript } from './types.js';
import { renderSnapshotForPrompt } from './memory-store.js';

// ── Output contract ─────────────────────────────────────────────────────
//
// We ask the LLM to emit a single response that contains three delimited
// sections, in order:
//
//   ===PATTERNS_JSON===
//   { ... }
//   ===END_PATTERNS_JSON===
//
//   ===NEW_INDEX===
//   <full markdown of updated MEMORY.md>
//   ===END_NEW_INDEX===
//
//   ===TOPIC_FILE: feedback_x.md===
//   <full updated content of that topic file>
//   ===END_TOPIC_FILE===
//
//   …repeat TOPIC_FILE blocks…
//
// Delimiter format mirrors Kultiv's existing mutation engine
// (`===UPDATED_ARTIFACT===`) for consistency.

const PATTERNS_OPEN = '===PATTERNS_JSON===';
const PATTERNS_CLOSE = '===END_PATTERNS_JSON===';
const INDEX_OPEN = '===NEW_INDEX===';
const INDEX_CLOSE = '===END_NEW_INDEX===';
const TOPIC_OPEN_RE = /^===TOPIC_FILE:\s*(.+?)===\s*$/m;
const TOPIC_CLOSE = '===END_TOPIC_FILE===';

// ── System Preamble ─────────────────────────────────────────────────────

export const DREAM_SYSTEM_PROMPT =
  'You are Kultiv\'s dreaming engine. You consolidate an agent\'s memory across many past sessions, ' +
  'merging duplicates, replacing stale facts with newer ones, surfacing recurring patterns, and pruning noise. ' +
  'You ALWAYS return three delimited sections — patterns JSON, the consolidated index, and zero or more updated ' +
  'topic files — in the exact format specified. Never invent file paths that were not in the input. Never make ' +
  'claims unsupported by the inputs. Be conservative: if a fact is ambiguous, keep the existing version rather ' +
  'than inventing a new one.';

// ── User Prompt Builder ─────────────────────────────────────────────────

export interface BuildDreamPromptOptions {
  snapshot: MemorySnapshot;
  sessions: SessionTranscript[];
  /** Patterns surfaced by the previous dream — informs what's still recurring vs resolved. */
  previousPatterns?: DreamPattern[];
  /** Recent Kultiv mutation wins — counts as a kind of session signal. */
  recentWins?: Array<{
    artifact: string;
    mutationType: string;
    fitnessDelta: number | null;
    timestamp: string;
    description?: string;
  }>;
  /** Optional user-supplied focus instructions. */
  instructions?: string;
}

export function buildDreamPrompt(options: BuildDreamPromptOptions): string {
  const { snapshot, sessions, previousPatterns = [], recentWins = [], instructions } = options;

  const previousPatternsBlock =
    previousPatterns.length > 0
      ? previousPatterns
          .map(
            (p) =>
              `  - [${p.severity}/${p.category}] ${p.id}: ${p.title} — targets=${
                p.targetArtifacts.join(',') || '(none)'
              }`,
          )
          .join('\n')
      : '  (none — this is the first dream or all prior patterns were resolved)';

  const winsBlock =
    recentWins.length > 0
      ? recentWins
          .slice(0, 20)
          .map(
            (w) =>
              `  - ${w.timestamp} artifact=${w.artifact} type=${w.mutationType} delta=${
                w.fitnessDelta ?? 'n/a'
              }${w.description ? ` — ${w.description}` : ''}`,
          )
          .join('\n')
      : '  (none)';

  const sessionsBlock =
    sessions.length > 0
      ? sessions
          .map(
            (s, i) =>
              `### SESSION ${i + 1} — id=${s.sessionId} branch=${s.gitBranch ?? 'n/a'} started=${s.startedAt} messages=${s.messageCount}\n${s.text}\n`,
          )
          .join('\n---\n\n')
      : '_no recent sessions_';

  const instructionsBlock = instructions && instructions.trim().length > 0
    ? `\n## User Instructions for This Dream\n${instructions.trim()}\n`
    : '';

  return `## Task: DREAM

You are consolidating an agent's memory by examining its past sessions and the current memory tier.

## Goals
1. **Merge duplicates** — combine entries that say the same thing.
2. **Replace stale facts** — if a session shows a fact has changed (e.g., a count, a tool name, a status), update the memory to match the latest evidence and remove the old version.
3. **Surface cross-session patterns** — recurring mistakes, user preferences confirmed multiple times, repeated workflows. These become structured \`patterns\` objects that downstream tooling will use as focus areas.
4. **Prune** — drop entries that are clearly stale, contradicted, or never-referenced.
5. **Preserve uncertainty** — if you cannot tell whether something is still true, keep the existing entry verbatim rather than guessing.

## Hard Rules
- Index file (\`MEMORY.md\`) MUST stay under 200 lines. Move detail into topic files.
- Each entry in the index MUST be a single line under ~150 characters.
- Topic files retain their existing frontmatter (\`name:\`, \`description:\`, \`type:\`) — update fields if content changes, but never remove them.
- Do NOT invent topic-file paths. Only emit \`TOPIC_FILE\` blocks for files that already exist OR for new files using the prefix conventions: \`user_*\`, \`feedback_*\`, \`project_*\`, \`reference_*\`.
- Do NOT include personally identifying information beyond what is already in the inputs.
${instructionsBlock}
## Pattern Surfacing
For each recurring signal you observe across 2+ sessions OR in the recent wins log, emit one pattern record. Pattern severity:
- \`high\`: caused production breakage, security issue, or repeated user frustration
- \`medium\`: notable inefficiency or recurring confusion
- \`low\`: minor preference or style note

## Inputs

### Recent Sessions (${sessions.length})
${sessionsBlock}

### Current Memory Tier
${renderSnapshotForPrompt(snapshot)}

### Patterns from the Previous Dream
${previousPatternsBlock}

### Recent Kultiv Mutation Wins
${winsBlock}

## Output Format (STRICT — copy delimiters exactly)

${PATTERNS_OPEN}
{
  "patterns": [
    {
      "id": "PT001",
      "title": "short headline",
      "severity": "high|medium|low",
      "category": "rule|preference|incident|fact",
      "targetArtifacts": ["agent-id", "..."] ,
      "evidence": ["session-id-or-source", "..."],
      "body": "1-3 sentences explaining the pattern with concrete evidence."
    }
  ],
  "summary": "1-3 sentence summary of what changed in this dream"
}
${PATTERNS_CLOSE}

${INDEX_OPEN}
<the entire updated MEMORY.md, ready to overwrite the existing file>
${INDEX_CLOSE}

${TOPIC_OPEN_RE.source.replace(/^\^|\$$/g, '').replace(/\\s\*$/, '')}feedback_example.md===
<the entire updated content of feedback_example.md>
${TOPIC_CLOSE}

(Repeat the TOPIC_FILE block for each topic file you are changing OR adding. Do NOT emit blocks for unchanged files.)`;
}

// ── Parser ──────────────────────────────────────────────────────────────

export interface ParsedDreamResponse {
  patterns: DreamPattern[];
  summary: string;
  newIndex: string;
  topicFiles: Array<{ relativePath: string; content: string }>;
  /** Set if the response was missing required sections; caller should treat as failure. */
  errors: string[];
}

export function parseDreamResponse(response: string): ParsedDreamResponse {
  const errors: string[] = [];

  const patternsRaw = extractBetween(response, PATTERNS_OPEN, PATTERNS_CLOSE);
  const indexRaw = extractBetween(response, INDEX_OPEN, INDEX_CLOSE);

  let patterns: DreamPattern[] = [];
  let summary = '';
  if (patternsRaw === null) {
    errors.push('missing PATTERNS_JSON section');
  } else {
    const parsed = safeParsePatternsJson(patternsRaw);
    patterns = parsed.patterns;
    summary = parsed.summary;
    if (parsed.error) errors.push(parsed.error);
  }

  if (indexRaw === null) {
    errors.push('missing NEW_INDEX section');
  }

  const topicFiles = extractTopicFiles(response);

  return {
    patterns,
    summary,
    newIndex: indexRaw ?? '',
    topicFiles,
    errors,
  };
}

// ── Internals ───────────────────────────────────────────────────────────

function extractBetween(haystack: string, open: string, close: string): string | null {
  const start = haystack.indexOf(open);
  if (start < 0) return null;
  const after = start + open.length;
  const end = haystack.indexOf(close, after);
  if (end < 0) return null;
  return haystack.slice(after, end).trim();
}

function safeParsePatternsJson(raw: string): {
  patterns: DreamPattern[];
  summary: string;
  error?: string;
} {
  // Strip markdown fences if the model wrapped its JSON.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { patterns: [], summary: '', error: `patterns JSON parse failed: ${String(err)}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { patterns: [], summary: '', error: 'patterns JSON is not an object' };
  }

  const obj = parsed as { patterns?: unknown; summary?: unknown };
  const summary = typeof obj.summary === 'string' ? obj.summary : '';

  if (!Array.isArray(obj.patterns)) {
    return { patterns: [], summary, error: 'patterns field is not an array' };
  }

  const patterns: DreamPattern[] = [];
  for (const p of obj.patterns) {
    const norm = normalizePattern(p);
    if (norm) patterns.push(norm);
  }
  return { patterns, summary };
}

function normalizePattern(input: unknown): DreamPattern | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : '';
  const title = typeof o.title === 'string' ? o.title : '';
  if (!id || !title) return null;
  const severity = isSeverity(o.severity) ? o.severity : 'medium';
  const category = isCategory(o.category) ? o.category : 'rule';
  const targets = Array.isArray(o.targetArtifacts)
    ? o.targetArtifacts.filter((x): x is string => typeof x === 'string')
    : [];
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.filter((x): x is string => typeof x === 'string')
    : [];
  const body = typeof o.body === 'string' ? o.body : '';
  return {
    id,
    title,
    severity,
    category,
    targetArtifacts: targets,
    evidence,
    body,
  };
}

function isSeverity(v: unknown): v is DreamPattern['severity'] {
  return v === 'high' || v === 'medium' || v === 'low';
}

function isCategory(v: unknown): v is DreamPattern['category'] {
  return v === 'rule' || v === 'preference' || v === 'incident' || v === 'fact';
}

function extractTopicFiles(response: string): Array<{ relativePath: string; content: string }> {
  const out: Array<{ relativePath: string; content: string }> = [];
  const headerRe = /^===TOPIC_FILE:\s*(.+?)===\s*$/gm;

  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(response)) !== null) {
    const relativePath = match[1].trim();
    const after = match.index + match[0].length;
    const closeIdx = response.indexOf(TOPIC_CLOSE, after);
    if (closeIdx < 0) continue;
    const content = response.slice(after, closeIdx).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (relativePath) {
      out.push({ relativePath, content });
    }
  }
  return out;
}
