import type { ScorerChainItem } from '../core/config.js';
import { runCommandScorer } from './command-scorer.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface EvaluatorResult {
  name: string;
  score: number;
  max: number;
  weight: number;
  details: Record<string, unknown>;
  passed: boolean;
}

export interface Scorecard {
  total_score: number;
  max_score: number;
  percentage: number;
  evaluators: EvaluatorResult[];
  timestamp: string;
}

// ── Chain Runner ─────────────────────────────────────────────────────────

/**
 * Run an evaluator chain in sequence and aggregate weighted scores into a scorecard.
 *
 * Each evaluator produces a result with a raw score and max. The chain runner
 * computes a weighted total: sum(score * weight) / sum(max * weight) * 100.
 */
export async function runChain(
  chain: ScorerChainItem[],
  projectRoot: string
): Promise<Scorecard> {
  if (chain.length === 0) {
    throw new Error('Scorer chain is empty — at least one evaluator is required');
  }

  const evaluators: EvaluatorResult[] = [];

  for (const item of chain) {
    let result: EvaluatorResult;

    if (item.command) {
      // Command-based scorer
      result = runCommandScorer(item.name, item.command, projectRoot);
      // Apply the configured weight (command scorer defaults weight to 1)
      result.weight = item.weight;
    } else if (item.type === 'pattern') {
      // Pattern scorer — placeholder for future implementation
      result = {
        name: item.name,
        score: 0,
        max: 1,
        weight: item.weight,
        details: { error: 'Pattern scorer not yet implemented', rules_file: item.rules_file },
        passed: false,
      };
    } else if (item.type === 'llm-judge') {
      // LLM judge — placeholder for future implementation
      result = {
        name: item.name,
        score: 0,
        max: 1,
        weight: item.weight,
        details: { error: 'LLM judge scorer not yet implemented' },
        passed: false,
      };
    } else if (item.type === 'script') {
      // Script scorer — treat as command if command is present, otherwise placeholder
      result = {
        name: item.name,
        score: 0,
        max: 1,
        weight: item.weight,
        details: { error: 'Script scorer requires a command field' },
        passed: false,
      };
    } else {
      result = {
        name: item.name,
        score: 0,
        max: 1,
        weight: item.weight,
        details: { error: `Unknown evaluator type: ${item.type ?? 'none'}` },
        passed: false,
      };
    }

    evaluators.push(result);
  }

  // Compute weighted totals
  const weightedScoreSum = evaluators.reduce(
    (sum, e) => sum + e.score * e.weight,
    0
  );
  const weightedMaxSum = evaluators.reduce(
    (sum, e) => sum + e.max * e.weight,
    0
  );

  const percentage = weightedMaxSum > 0
    ? Math.round((weightedScoreSum / weightedMaxSum) * 10000) / 100
    : 0;

  return {
    total_score: weightedScoreSum,
    max_score: weightedMaxSum,
    percentage,
    evaluators,
    timestamp: new Date().toISOString(),
  };
}
