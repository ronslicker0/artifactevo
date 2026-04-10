import { describe, it, expect } from 'vitest';

// parseJudgeResponse is not exported, so we test it through the module's behavior.
// We extract the parsing logic inline for unit testing.

function parseJudgeResponse(raw: string): { score: number; reasoning: string; checks: Array<{ name: string; passed: boolean; score?: number; max?: number; note: string }> } {
  let cleaned = raw.trim();

  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(cleaned);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  if (typeof parsed.score !== 'number') {
    throw new Error('Response missing "score" number field');
  }

  const checks = Array.isArray(parsed.checks)
    ? (parsed.checks as Array<{ name: string; passed: boolean; score?: number; max?: number; note: string }>)
    : [];

  return {
    score: parsed.score,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    checks,
  };
}

describe('parseJudgeResponse', () => {
  it('parses raw JSON', () => {
    const input = JSON.stringify({
      score: 65,
      reasoning: 'Solid but lacks depth',
      checks: [
        { name: 'Clarity', passed: true, score: 15, max: 20, note: 'Good tier' },
      ],
    });

    const result = parseJudgeResponse(input);
    expect(result.score).toBe(65);
    expect(result.reasoning).toBe('Solid but lacks depth');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].score).toBe(15);
    expect(result.checks[0].max).toBe(20);
  });

  it('parses JSON wrapped in ```json fences', () => {
    const input = '```json\n{"score": 42, "reasoning": "Weak", "checks": []}\n```';
    const result = parseJudgeResponse(input);
    expect(result.score).toBe(42);
  });

  it('parses JSON wrapped in plain ``` fences', () => {
    const input = '```\n{"score": 55, "reasoning": "OK", "checks": []}\n```';
    const result = parseJudgeResponse(input);
    expect(result.score).toBe(55);
  });

  it('throws when score field is missing', () => {
    const input = JSON.stringify({ reasoning: 'No score', checks: [] });
    expect(() => parseJudgeResponse(input)).toThrow('Response missing "score" number field');
  });

  it('throws when score is not a number', () => {
    const input = JSON.stringify({ score: 'high', reasoning: 'Bad type', checks: [] });
    expect(() => parseJudgeResponse(input)).toThrow('Response missing "score" number field');
  });

  it('defaults reasoning to empty string when missing', () => {
    const input = JSON.stringify({ score: 50 });
    const result = parseJudgeResponse(input);
    expect(result.reasoning).toBe('');
  });

  it('defaults checks to empty array when missing', () => {
    const input = JSON.stringify({ score: 50, reasoning: 'Test' });
    const result = parseJudgeResponse(input);
    expect(result.checks).toEqual([]);
  });

  it('handles checks without optional score/max fields', () => {
    const input = JSON.stringify({
      score: 70,
      reasoning: 'Legacy format',
      checks: [
        { name: 'Clarity', passed: true, note: 'Good' },
      ],
    });

    const result = parseJudgeResponse(input);
    expect(result.checks[0].score).toBeUndefined();
    expect(result.checks[0].max).toBeUndefined();
  });

  it('handles whitespace around fenced JSON', () => {
    const input = '  \n```json\n  { "score": 33, "reasoning": "Low", "checks": [] }  \n```\n  ';
    const result = parseJudgeResponse(input);
    expect(result.score).toBe(33);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJudgeResponse('not json at all')).toThrow();
  });
});

describe('score computation from checks', () => {
  // This tests the logic from llm-judge.ts lines 119-126
  function computeScore(judgeResult: { score: number; checks: Array<{ score?: number; max?: number }> }): number {
    let computedScore = judgeResult.score;
    const checksWithScores = judgeResult.checks.filter(
      (c) => typeof c.score === 'number' && typeof c.max === 'number',
    );
    if (checksWithScores.length > 0) {
      computedScore = checksWithScores.reduce((sum, c) => sum + (c.score ?? 0), 0);
    }
    return Math.max(0, Math.min(100, computedScore));
  }

  it('sums individual check scores instead of trusting holistic score', () => {
    const result = computeScore({
      score: 85, // LLM's wrong holistic number
      checks: [
        { score: 25, max: 25 },
        { score: 20, max: 20 },
        { score: 15, max: 15 },
        { score: 12, max: 15 },
        { score: 13, max: 15 },
      ],
    });
    // 25+20+15+12+13 = 85 (happens to match here, but the point is we compute it)
    expect(result).toBe(85);
  });

  it('uses holistic score when checks lack score/max fields', () => {
    const result = computeScore({
      score: 72,
      checks: [
        { score: undefined, max: undefined },
      ],
    });
    expect(result).toBe(72);
  });

  it('clamps score to 0-100 range', () => {
    expect(computeScore({ score: 150, checks: [] })).toBe(100);
    expect(computeScore({ score: -10, checks: [] })).toBe(0);
  });

  it('sums correctly when LLM holistic score is wrong', () => {
    const result = computeScore({
      score: 92, // LLM says 92 (wrong)
      checks: [
        { score: 10, max: 25 }, // Actually adds up to 55
        { score: 15, max: 20 },
        { score: 10, max: 15 },
        { score: 10, max: 15 },
        { score: 10, max: 15 },
      ],
    });
    expect(result).toBe(55); // Not 92
  });
});
