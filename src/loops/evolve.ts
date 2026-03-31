import { resolve } from 'node:path';
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

// ── Evolve Orchestrator ─────────────────────────────────────────────────

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
  const budget = options?.budget ?? config.evolution.budget_per_session;
  const feedbackInterval = config.evolution.feedback_interval;
  const outerInterval = config.evolution.outer_interval;
  const plateauWindow = config.evolution.plateau_window;

  // 1. Setup
  const archivePath = resolve('.evo', 'archive.jsonl');
  const archive = new Archive(archivePath);
  archive.load();

  const provider = createProvider(config.llm);

  // 2. Get artifact IDs
  const allArtifactIds = Object.keys(config.artifacts);
  const artifactIds = options?.artifactId
    ? [options.artifactId]
    : allArtifactIds;

  if (artifactIds.length === 0) {
    throw new Error('No artifacts configured. Use `evo add <name> <path>` to register artifacts.');
  }

  if (options?.artifactId && !config.artifacts[options.artifactId]) {
    throw new Error(
      `Artifact "${options.artifactId}" not found in config. Available: ${allArtifactIds.join(', ')}`
    );
  }

  console.log(bold('\nArtifactEvo \u2014 Starting evolution session'));
  console.log(dim(`  Budget: ${budget} experiments`));
  console.log(dim(`  Artifacts: ${artifactIds.join(', ')}`));
  console.log(dim(`  Mode: ${options?.dryRun ? 'dry-run' : options?.safe ? 'safe' : 'normal'}`));
  console.log('');

  // 3. Evolution loop
  const experiments: InnerLoopResult[] = [];
  let outerLoopRan = false;
  let totalTokenCost = 0;
  let consecutiveRegressions = 0;

  for (let i = 0; i < budget; i++) {
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

  // 4. Print summary
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
