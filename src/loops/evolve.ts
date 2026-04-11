import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { EvoConfig } from '../core/config.js';
import { Archive, type ArchiveEntry } from '../core/archive.js';
import { createProvider } from '../llm/factory.js';
import { innerLoop, type InnerLoopResult } from './inner.js';
import { outerLoop } from './outer.js';
import { detectAntiPatterns } from '../detection/anti-patterns.js';
import { detectPlateau } from '../detection/plateau.js';

// ── ANSI Colors ─────────────────────────────────────────────────────────

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;

// ── Types ────────────────────────────────────────────────────────────────

export interface EvolveOptions {
  budget?: number;
  artifactId?: string;
  safe?: boolean;
  dryRun?: boolean;
}

export interface EvolveResult {
  experiments: InnerLoopResult[];
  outerLoopRan: boolean;
  totalTokenCost: number;
  summary: string;
}

// ── Session State (pause/resume) ────────────────────────────────────────

export interface SessionState {
  session_id: string;
  started_at: string;
  paused_at: string | null;
  status: 'running' | 'paused' | 'completed';
  current_experiment: number;
  total_budget: number;
  artifact_queue: string[];
  results_so_far: number[];
  options: EvolveOptions;
}

const SESSION_STATE_FILE = 'session-state.json';
const PAUSE_SIGNAL_FILE = 'pause-signal';

function sessionStatePath(kultivDir: string): string {
  return join(kultivDir, SESSION_STATE_FILE);
}

function pauseSignalPath(kultivDir: string): string {
  return join(kultivDir, PAUSE_SIGNAL_FILE);
}

function generateSessionId(): string {
  return `kultiv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasPauseSignal(kultivDir: string): boolean {
  return existsSync(pauseSignalPath(kultivDir));
}

function consumePauseSignal(kultivDir: string): void {
  const path = pauseSignalPath(kultivDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function saveSessionState(kultivDir: string, state: SessionState): void {
  if (!existsSync(kultivDir)) {
    mkdirSync(kultivDir, { recursive: true });
  }
  writeFileSync(sessionStatePath(kultivDir), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Create a pause signal file. The evolve loop checks for this at the start
 * of each iteration and gracefully pauses.
 */
export function pauseEvolution(kultivDir: string): boolean {
  if (!existsSync(kultivDir)) {
    return false;
  }
  writeFileSync(pauseSignalPath(kultivDir), new Date().toISOString(), 'utf-8');
  return true;
}

/**
 * Read the current session state, or null if no session exists.
 */
export function getSessionState(kultivDir: string): SessionState | null {
  const path = sessionStatePath(kultivDir);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

/**
 * Clear the session state file and any pause signal.
 */
export function clearSession(kultivDir: string): void {
  const statePath = sessionStatePath(kultivDir);
  if (existsSync(statePath)) unlinkSync(statePath);
  consumePauseSignal(kultivDir);
}

// ── Evolve Orchestrator ─────────────────────────────────────────────────

// ── Improvement Report ─────────────────────────────────────────────────

/**
 * Generate an improvement report when a plateau is detected.
 * Surfaces per-criterion scores from the most recent archive entry
 * so operators know exactly which criteria need manual attention.
 */
function writeImprovementReport(
  kultivDir: string,
  artifactId: string,
  archive: Archive,
): void {
  const entries = archive.getByArtifact(artifactId);
  const latest = entries[entries.length - 1];
  if (!latest) return;

  const checks = latest.scorecard_checks ?? [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = join(kultivDir, 'reports', `${artifactId}-${timestamp}.md`);

  const reportsDir = join(kultivDir, 'reports');
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true });
  }

  // Build per-criterion breakdown
  let criteriaSection = '';
  if (checks.length > 0) {
    const sorted = [...checks].sort((a, b) => {
      const aRatio = a.max > 0 ? a.score / a.max : 0;
      const bRatio = b.max > 0 ? b.score / b.max : 0;
      return aRatio - bRatio;
    });
    criteriaSection = `## Per-Criterion Breakdown\n\n`;
    criteriaSection += `| Criterion | Score | Max | % | Status |\n`;
    criteriaSection += `|-----------|-------|-----|---|--------|\n`;
    for (const c of sorted) {
      const pct = c.max > 0 ? Math.round((c.score / c.max) * 100) : 0;
      const status = pct >= 75 ? 'Good' : pct >= 50 ? 'Adequate' : 'Needs Work';
      criteriaSection += `| ${c.name} | ${c.score} | ${c.max} | ${pct}% | ${status} |\n`;
    }
    criteriaSection += '\n';

    // Weakest criteria recommendations
    const weak = sorted.filter(c => (c.score / c.max) < 0.75);
    if (weak.length > 0) {
      criteriaSection += `## Recommended Improvements\n\n`;
      criteriaSection += `Focus on these criteria to break through the plateau:\n\n`;
      for (const c of weak) {
        const pct = Math.round((c.score / c.max) * 100);
        const gap = c.max - c.score;
        criteriaSection += `### ${c.name} (${pct}% — ${gap} pts available)\n\n`;
        if (c.note) {
          criteriaSection += `Current assessment: ${c.note}\n\n`;
        }
        criteriaSection += `To improve: add concrete code examples, decision trees, negative examples, or edge case handling for this criterion.\n\n`;
      }
    }
  } else {
    criteriaSection = `## Per-Criterion Breakdown\n\nNo per-criterion data available. Run a baseline with the latest scoring engine to populate.\n\n`;
  }

  // Mutation history summary
  const recentHistory = entries.slice(-10);
  let historySection = `## Recent Mutation History\n\n`;
  historySection += `| Gen | Type | Score | Status |\n`;
  historySection += `|-----|------|-------|--------|\n`;
  for (const e of recentHistory) {
    historySection += `| ${e.genid} | ${e.mutation_type} | ${e.score ?? 'n/a'}/${e.max_score} | ${e.status} |\n`;
  }
  historySection += '\n';

  const report = `# Improvement Report: ${artifactId}

Generated: ${new Date().toISOString()}
Current Score: ${latest.score}/${latest.max_score} (${latest.score !== null ? Math.round((latest.score / latest.max_score) * 100) : 'n/a'}%)
Status: PLATEAUED — automated mutations are not improving this agent

${criteriaSection}
${historySection}
## Next Steps

1. Review the weakest criteria above and manually improve the agent prompt
2. Run \`kultiv baseline --artifact ${artifactId}\` to verify the score increased
3. Resume evolution with \`kultiv evolve --artifact ${artifactId} --budget 5\`
`;

  writeFileSync(reportPath, report, 'utf-8');
  console.log(cyan(`  Improvement report written: ${reportPath}`));
}

/**
 * Full evolution orchestrator combining inner loop, feedback, and outer loop.
 *
 * Flow:
 * 1. Load config, create archive, create LLM provider
 * 2. Get artifact IDs (all or specified)
 * 3. For each budget iteration:
 *    a. Select artifact (round-robin)
 *    b. Run inner loop
 *    c. Print colored result
 *    d. Every feedback_interval: detect and print anti-patterns
 *    e. Every outer_interval (or on plateau): run outer loop
 * 4. Print summary
 */
export async function evolve(
  config: EvoConfig,
  options?: EvolveOptions,
): Promise<EvolveResult> {
  const kultivDir = resolve('.kultiv');
  const feedbackInterval = config.evolution.feedback_interval;
  const outerInterval = config.evolution.outer_interval;
  const plateauWindow = config.evolution.plateau_window;

  // 1. Setup
  const archivePath = resolve('.kultiv', 'archive.jsonl');
  const archive = new Archive(archivePath);
  archive.load();

  const provider = createProvider(config.llm);

  // 2. Get artifact IDs
  const allArtifactIds = Object.keys(config.artifacts);

  // Check for a paused session to resume
  const existingSession = getSessionState(kultivDir);
  let startIndex = 0;
  let budget: number;
  let artifactIds: string[];
  let sessionId: string;
  let experiments: InnerLoopResult[] = [];
  let outerLoopRan = false;
  let totalTokenCost = 0;

  if (existingSession && existingSession.status === 'paused') {
    // Resume from paused session
    budget = existingSession.total_budget;
    startIndex = existingSession.current_experiment;
    artifactIds = existingSession.artifact_queue;
    sessionId = existingSession.session_id;

    console.log(bold('\nKultiv \u2014 Resuming paused session'));
    console.log(dim(`  Session: ${sessionId}`));
    console.log(dim(`  Resuming from experiment ${startIndex + 1}/${budget}`));
    console.log(dim(`  Artifacts: ${artifactIds.join(', ')}`));
    console.log('');
  } else {
    // Fresh session
    budget = options?.budget ?? config.evolution.budget_per_session;
    artifactIds = options?.artifactId
      ? [options.artifactId]
      : allArtifactIds;
    sessionId = generateSessionId();

    if (artifactIds.length === 0) {
      throw new Error('No artifacts configured. Use `kultiv add <name> <path>` to register artifacts.');
    }

    if (options?.artifactId && !config.artifacts[options.artifactId]) {
      throw new Error(
        `Artifact "${options.artifactId}" not found in config. Available: ${allArtifactIds.join(', ')}`
      );
    }

    // Clear any stale session data
    clearSession(kultivDir);

    console.log(bold('\nKultiv \u2014 Starting evolution session'));
    console.log(dim(`  Session: ${sessionId}`));
    console.log(dim(`  Budget: ${budget} experiments`));
    console.log(dim(`  Artifacts: ${artifactIds.join(', ')}`));
    console.log(dim(`  Mode: ${options?.dryRun ? 'dry-run' : options?.safe ? 'safe' : 'normal'}`));
    console.log('');
  }

  // Save initial session state
  const effectiveOptions = options ?? {};
  saveSessionState(kultivDir, {
    session_id: sessionId,
    started_at: existingSession?.started_at ?? new Date().toISOString(),
    paused_at: null,
    status: 'running',
    current_experiment: startIndex,
    total_budget: budget,
    artifact_queue: artifactIds,
    results_so_far: existingSession?.results_so_far ?? [],
    options: effectiveOptions,
  });

  // 3. Evolution loop
  let consecutiveRegressions = 0;

  for (let i = startIndex; i < budget; i++) {
    // Check for pause signal before each iteration
    if (hasPauseSignal(kultivDir)) {
      consumePauseSignal(kultivDir);
      console.log(yellow(bold('\n  PAUSED: Pause signal received. Saving session state.')));

      saveSessionState(kultivDir, {
        session_id: sessionId,
        started_at: existingSession?.started_at ?? new Date().toISOString(),
        paused_at: new Date().toISOString(),
        status: 'paused',
        current_experiment: i,
        total_budget: budget,
        artifact_queue: artifactIds,
        results_so_far: [
          ...(existingSession?.results_so_far ?? []),
          ...experiments.map((e) => e.genid),
        ],
        options: effectiveOptions,
      });

      const summary = buildSummary(experiments, outerLoopRan, totalTokenCost);
      console.log(summary);
      console.log(dim('  Resume with: kultiv resume'));

      return {
        experiments,
        outerLoopRan,
        totalTokenCost,
        summary,
      };
    }

    const artifactId = artifactIds[i % artifactIds.length];

    console.log(dim(`[${i + 1}/${budget}] `) + `Evolving ${bold(artifactId)}...`);

    const result = await innerLoop(config, artifactId, archive, provider, {
      dryRun: options?.dryRun,
      safe: options?.safe,
    });

    experiments.push(result);
    totalTokenCost += result.tokenCost;

    printResult(result);

    if (result.status === 'regression') {
      consecutiveRegressions++;
    } else {
      consecutiveRegressions = 0;
    }

    // Persist session state after each experiment (crash-safe)
    saveSessionState(kultivDir, {
      session_id: sessionId,
      started_at: existingSession?.started_at ?? new Date().toISOString(),
      paused_at: null,
      status: 'running',
      current_experiment: i + 1,
      total_budget: budget,
      artifact_queue: artifactIds,
      results_so_far: [
        ...(existingSession?.results_so_far ?? []),
        ...experiments.map((e) => e.genid),
      ],
      options: effectiveOptions,
    });

    if (consecutiveRegressions >= config.automation.max_regressions_before_pause) {
      console.log(red(bold(`\n  PAUSED: ${consecutiveRegressions} consecutive regressions. Stopping.`)));
      break;
    }

    // Feedback check every N runs
    if ((i + 1) % feedbackInterval === 0) {
      const allEntries = archive.getAll() as ArchiveEntry[];
      const patterns = detectAntiPatterns(allEntries, artifactId);
      if (patterns.length > 0) {
        console.log(yellow('\n  Anti-patterns detected:'));
        for (const p of patterns) {
          const icon = p.severity === 'high' ? red('!!') : yellow('!!');
          console.log(`    ${icon} ${p.type}: ${p.message}`);
        }
        console.log('');
      }
    }

    // Outer loop check every M runs or on plateau
    const shouldRunOuter = (i + 1) % outerInterval === 0;
    const scoreHistory = archive.getByArtifact(artifactId).map((e) => ({ score: e.score }));
    const plateauResult = detectPlateau(scoreHistory, plateauWindow);
    const isPlateaued = plateauResult.detected;

    if ((shouldRunOuter || isPlateaued) && !options?.dryRun) {
      if (isPlateaued) {
        console.log(yellow(`\n  Plateau detected on ${artifactId} \u2014 triggering meta-strategy revision`));
        // Generate improvement report with per-criterion breakdown
        writeImprovementReport(kultivDir, artifactId, archive);
      } else {
        console.log(dim('\n  Running outer loop (meta-strategy revision)...'));
      }

      const outerResult = await outerLoop(config, archive, provider);
      outerLoopRan = true;
      totalTokenCost += outerResult.tokenCost;

      if (outerResult.updated) {
        console.log(cyan('  Meta-strategy updated.'));
        if (outerResult.diff) {
          const diffLines = outerResult.diff.split('\n').slice(0, 10);
          for (const line of diffLines) {
            console.log(dim(`    ${line}`));
          }
          if (outerResult.diff.split('\n').length > 10) {
            console.log(dim(`    ... (${outerResult.diff.split('\n').length - 10} more lines)`));
          }
        }
      } else {
        console.log(dim('  Meta-strategy unchanged.'));
      }
      console.log('');
    }
  }

  // 4. Mark session as completed
  saveSessionState(kultivDir, {
    session_id: sessionId,
    started_at: existingSession?.started_at ?? new Date().toISOString(),
    paused_at: null,
    status: 'completed',
    current_experiment: budget,
    total_budget: budget,
    artifact_queue: artifactIds,
    results_so_far: [
      ...(existingSession?.results_so_far ?? []),
      ...experiments.map((e) => e.genid),
    ],
    options: effectiveOptions,
  });

  // 5. Print summary
  const summary = buildSummary(experiments, outerLoopRan, totalTokenCost);
  console.log(summary);

  return {
    experiments,
    outerLoopRan,
    totalTokenCost,
    summary,
  };
}

// ── Print Helpers ───────────────────────────────────────────────────────

function printResult(result: InnerLoopResult): void {
  const statusLabel = {
    success: green('SUCCESS'),
    regression: red('REGRESSION'),
    neutral: yellow('NEUTRAL'),
    crash: red('CRASH'),
  }[result.status];

  const scoreStr = result.score !== null
    ? `${result.score}/${result.maxScore}`
    : 'n/a';

  console.log(
    `  ${statusLabel} gen=${result.genid} ` +
    `type=${dim(result.mutationType)} ` +
    `score=${scoreStr} ` +
    `tokens=${dim(String(result.tokenCost))}`
  );
}

function buildSummary(
  experiments: InnerLoopResult[],
  outerLoopRan: boolean,
  totalTokenCost: number,
): string {
  const successes = experiments.filter((e) => e.status === 'success').length;
  const regressions = experiments.filter((e) => e.status === 'regression').length;
  const neutrals = experiments.filter((e) => e.status === 'neutral').length;
  const crashes = experiments.filter((e) => e.status === 'crash').length;

  const lines: string[] = [
    '',
    bold('Session Summary'),
    '\u2500'.repeat(40),
    `  Experiments:  ${experiments.length}`,
    `  ${green('Success')}:     ${successes}`,
    `  ${red('Regression')}: ${regressions}`,
    `  ${yellow('Neutral')}:     ${neutrals}`,
  ];

  if (crashes > 0) {
    lines.push(`  ${red('Crash')}:       ${crashes}`);
  }

  lines.push(`  Outer loop:   ${outerLoopRan ? 'ran' : 'skipped'}`);
  lines.push(`  Token cost:   ~${totalTokenCost.toLocaleString()}`);
  lines.push('');

  return lines.join('\n');
}
