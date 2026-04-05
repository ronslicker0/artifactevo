import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPatch } from 'diff';
import type { EvoConfig } from '../core/config.js';
import type { Archive, ArchiveEntry } from '../core/archive.js';
import type { LLMProvider } from '../llm/provider.js';
import { detectAntiPatterns } from '../detection/anti-patterns.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface OuterLoopResult {
  updated: boolean;
  diff: string | null;
  tokenCost: number;
}

// ── Stats Computation ───────────────────────────────────────────────────

interface MutationTypeStats {
  type: string;
  total: number;
  successes: number;
  regressions: number;
  successRate: number;
}

interface ArtifactStats {
  artifact: string;
  total: number;
  successes: number;
  regressions: number;
  bestScore: number | null;
  latestScore: number | null;
}

function computeGlobalStats(entries: ReadonlyArray<ArchiveEntry>): {
  mutationTypes: MutationTypeStats[];
  artifacts: ArtifactStats[];
  overallSuccessRate: number;
  totalExperiments: number;
} {
  // Mutation type stats
  const typeMap = new Map<string, { total: number; successes: number; regressions: number }>();
  for (const e of entries) {
    if (e.status === 'crash') continue;
    const stats = typeMap.get(e.mutation_type) ?? { total: 0, successes: 0, regressions: 0 };
    stats.total++;
    if (e.status === 'success') stats.successes++;
    if (e.status === 'regression') stats.regressions++;
    typeMap.set(e.mutation_type, stats);
  }

  const mutationTypes: MutationTypeStats[] = [];
  for (const [type, stats] of typeMap) {
    mutationTypes.push({
      type,
      total: stats.total,
      successes: stats.successes,
      regressions: stats.regressions,
      successRate: stats.total > 0 ? stats.successes / stats.total : 0,
    });
  }
  mutationTypes.sort((a, b) => b.total - a.total);

  // Artifact stats
  const artifactMap = new Map<string, ArchiveEntry[]>();
  for (const e of entries) {
    const list = artifactMap.get(e.artifact) ?? [];
    list.push(e);
    artifactMap.set(e.artifact, list);
  }

  const artifacts: ArtifactStats[] = [];
  for (const [artifact, artEntries] of artifactMap) {
    const scored = artEntries.filter((e) => e.score !== null);
    artifacts.push({
      artifact,
      total: artEntries.length,
      successes: artEntries.filter((e) => e.status === 'success').length,
      regressions: artEntries.filter((e) => e.status === 'regression').length,
      bestScore: scored.length > 0 ? Math.max(...scored.map((e) => e.score as number)) : null,
      latestScore: scored.length > 0 ? scored[scored.length - 1].score : null,
    });
  }

  // Overall
  const nonCrash = entries.filter((e) => e.status !== 'crash');
  const overallSuccessRate =
    nonCrash.length > 0
      ? nonCrash.filter((e) => e.status === 'success').length / nonCrash.length
      : 0;

  return {
    mutationTypes,
    artifacts,
    overallSuccessRate,
    totalExperiments: entries.length,
  };
}

// ── Outer Loop ──────────────────────────────────────────────────────────

/**
 * Outer loop: revise the meta-strategy based on global archive statistics.
 *
 * Flow:
 * 1. Read current meta-strategy
 * 2. Compute global stats from archive
 * 3. Detect anti-patterns across all artifacts
 * 4. Build prompt asking the LLM to revise the meta-strategy
 * 5. Parse updated strategy from response
 * 6. Write updated meta-strategy file (backup old one first)
 * 7. Return diff
 */
export async function outerLoop(
  config: EvoConfig,
  archive: Archive,
  provider: LLMProvider,
): Promise<OuterLoopResult> {
  const strategyPath = resolve(config.meta_strategy_path);

  // 1. Read current meta-strategy
  let currentStrategy: string;
  try {
    currentStrategy = readFileSync(strategyPath, 'utf-8');
  } catch {
    currentStrategy = '(no meta-strategy file found)';
  }

  // 2. Compute global stats
  const allEntries = archive.getAll();
  if (allEntries.length < 3) {
    // Not enough data to meaningfully revise the strategy
    return { updated: false, diff: null, tokenCost: 0 };
  }

  const stats = computeGlobalStats(allEntries);

  // 3. Detect anti-patterns (across all artifacts)
  const artifactIds = [...new Set(allEntries.map((e) => e.artifact))];
  const antiPatterns = artifactIds.flatMap((id) =>
    detectAntiPatterns([...allEntries], id).map((p) => ({ ...p, artifact: id }))
  );

  // 4. Build prompt
  const prompt = buildOuterPrompt(currentStrategy, stats, antiPatterns);

  const systemPreamble =
    'You are the meta-strategy optimizer for Kultiv, an agent improvement system. ' +
    'Your job is to revise the mutation strategy based on observed performance data. ' +
    'Respond with ONLY the updated meta-strategy markdown content. No wrapping code blocks.';

  const response = await provider.generate([
    { role: 'user', content: `${systemPreamble}\n\n${prompt}` },
  ]);

  const updatedStrategy = response.content.trim();
  const tokenCost = response.input_tokens + response.output_tokens;

  // 5. Check if meaningful change
  if (updatedStrategy === currentStrategy.trim()) {
    return { updated: false, diff: null, tokenCost };
  }

  // 6. Backup and write
  if (existsSync(strategyPath)) {
    copyFileSync(strategyPath, strategyPath + '.backup');
  }
  writeFileSync(strategyPath, updatedStrategy + '\n', 'utf-8');

  // 7. Compute diff
  const diff = createPatch(
    config.meta_strategy_path,
    currentStrategy,
    updatedStrategy + '\n',
    'previous',
    'updated',
  );

  return { updated: true, diff, tokenCost };
}

// ── Prompt Builder ──────────────────────────────────────────────────────

interface AntiPatternWithArtifact {
  type: string;
  message: string;
  severity: string;
  suggestion: string;
  artifact: string;
}

function buildOuterPrompt(
  currentStrategy: string,
  stats: ReturnType<typeof computeGlobalStats>,
  antiPatterns: AntiPatternWithArtifact[],
): string {
  const typeStatsBlock = stats.mutationTypes
    .map(
      (t) =>
        `  ${t.type}: ${t.total} total, ${t.successes} success (${Math.round(t.successRate * 100)}%), ${t.regressions} regression`
    )
    .join('\n');

  const artifactStatsBlock = stats.artifacts
    .map(
      (a) =>
        `  ${a.artifact}: ${a.total} experiments, best=${a.bestScore ?? 'n/a'}, latest=${a.latestScore ?? 'n/a'}, success=${a.successes}, regression=${a.regressions}`
    )
    .join('\n');

  const antiPatternBlock = antiPatterns.length > 0
    ? antiPatterns
        .map((p) => `  [${p.severity}] ${p.type} on ${p.artifact}: ${p.message}`)
        .join('\n')
    : '  (none detected)';

  return `## Current Meta-Strategy
${currentStrategy}

## Global Statistics (${stats.totalExperiments} total experiments, ${Math.round(stats.overallSuccessRate * 100)}% overall success rate)

### Mutation Type Performance
${typeStatsBlock}

### Artifact Performance
${artifactStatsBlock}

### Detected Anti-Patterns
${antiPatternBlock}

## Task
Revise the meta-strategy to improve overall success rate and address any anti-patterns.
Specific guidance:
- Deprioritize mutation types with low success rates
- Adjust strategies for artifacts that are struggling
- Add new diversity rules if type fixation is detected
- Update the "Current Biases" section with specific adjustments
- Keep the same markdown structure and sections

Respond with the COMPLETE updated meta-strategy markdown. No code blocks or extra formatting.`;
}
