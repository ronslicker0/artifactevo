import type { LLMProvider } from '../llm/provider.js';
import type { EvaluatorResult } from './chain-runner.js';

// ── LLM Judge Types ─────────────────────────────────────────────────────

export interface LLMJudgeConfig {
  provider: LLMProvider;
  rubric?: string;
}

interface JudgeCheck {
  name: string;
  passed: boolean;
  score?: number;
  max?: number;
  note: string;
}

interface JudgeResponse {
  score: number;
  reasoning: string;
  checks: JudgeCheck[];
}

// ── Default Rubric ──────────────────────────────────────────────────────

const DEFAULT_RUBRIC = `Evaluate the artifact on the following criteria:
1. Clarity — Is the content clear and unambiguous?
2. Completeness — Does it cover all necessary aspects?
3. Correctness — Is the content factually and technically accurate?
4. Structure — Is it well-organized and easy to follow?
5. Best Practices — Does it follow established conventions and standards?`;

// ── LLM Judge Scorer ────────────────────────────────────────────────────

/**
 * Use an LLM to evaluate an artifact against a rubric.
 *
 * The judge:
 * 1. Builds a prompt asking the LLM to evaluate the artifact
 * 2. Requests a JSON response with { score, reasoning, checks }
 * 3. Parses the response, handling code fences
 * 4. Maps the 0-100 score to the evaluator weight
 */
export async function runLLMJudge(
  name: string,
  artifactContent: string,
  weight: number,
  config: LLMJudgeConfig,
): Promise<EvaluatorResult> {
  const rubric = config.rubric ?? DEFAULT_RUBRIC;

  const prompt = `You are a strict, calibrated evaluator. Score EACH criterion independently using the tier descriptions in the rubric, then SUM the scores.

## Scoring Rules
- For each criterion, select the tier whose description the artifact FULLY satisfies. If between tiers, use the LOWER tier.
- The total score is the arithmetic SUM of all criterion scores. Do NOT adjust holistically.
- Calibration: 50-65 is normal for a solid prompt. Above 80 requires concrete code examples, edge cases, AND negative examples. Below 40 means major gaps.
- "Mentioning" a topic is NOT the same as "covering" it. Require: specific patterns, copy-pasteable code, failure mode handling, actionable constraints.

## Rubric
${rubric}

## Artifact Content
<artifact>
${artifactContent}
</artifact>

## Response Format
For each criterion, state which tier matched and why, then assign that tier's point value.
Sum all criterion scores for the total.

Respond with ONLY a JSON object (no markdown fences, no extra text):

{
  "score": <SUM of criterion scores>,
  "reasoning": "<1-2 sentence summary>",
  "checks": [
    { "name": "<criterion>", "passed": <true if score >= 50% of max>, "score": <pts awarded>, "max": <max pts>, "note": "<tier + reason>" }
  ]
}`;

  let rawContent: string;
  try {
    const response = await config.provider.generate(
      [{ role: 'user', content: prompt }],
      { maxTokens: 2048, temperature: 0.1 }
    );
    rawContent = response.content;
  } catch (err) {
    return {
      name,
      score: 0,
      max: 1,
      weight,
      details: { error: `LLM judge call failed: ${String(err)}` },
      passed: false,
    };
  }

  // Parse the JSON response, stripping code fences if present
  let judgeResult: JudgeResponse;
  try {
    judgeResult = parseJudgeResponse(rawContent);
  } catch (err) {
    return {
      name,
      score: 0,
      max: 1,
      weight,
      details: {
        error: `Failed to parse LLM judge response: ${String(err)}`,
        raw_response: rawContent.slice(0, 2000),
      },
      passed: false,
    };
  }

  // Compute score: prefer summing individual check scores over trusting the LLM's holistic number
  let computedScore = judgeResult.score;
  const checksWithScores = judgeResult.checks.filter(c => typeof c.score === 'number' && typeof c.max === 'number');
  if (checksWithScores.length > 0) {
    computedScore = checksWithScores.reduce((sum, c) => sum + (c.score ?? 0), 0);
  }
  const clampedScore = Math.max(0, Math.min(100, computedScore));
  const normalizedScore = clampedScore / 100; // Map to 0..1

  return {
    name,
    score: normalizedScore,
    max: 1,
    weight,
    details: {
      llm_score: clampedScore,
      reasoning: judgeResult.reasoning,
      checks: judgeResult.checks,
      rubric,
    },
    passed: clampedScore >= 60,
  };
}

// ── Response Parsing ────────────────────────────────────────────────────

/**
 * Parse the LLM judge response, handling common formats:
 * - Raw JSON
 * - JSON wrapped in ```json ... ``` code fences
 * - JSON wrapped in ``` ... ``` code fences
 */
function parseJudgeResponse(raw: string): JudgeResponse {
  let cleaned = raw.trim();

  // Strip markdown code fences
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(cleaned);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  // Validate required fields
  if (typeof parsed.score !== 'number') {
    throw new Error('Response missing "score" number field');
  }

  const checks = Array.isArray(parsed.checks)
    ? (parsed.checks as JudgeCheck[])
    : [];

  return {
    score: parsed.score,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    checks,
  };
}
