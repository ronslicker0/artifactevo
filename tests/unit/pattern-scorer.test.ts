import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPatternScorer } from '../../src/scoring/pattern-scorer.js';
import * as fs from 'node:fs';

vi.mock('node:fs');

const mockReadFileSync = vi.mocked(fs.readFileSync);

describe('runPatternScorer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Forbid mode (default) ──────────────────────────────────────────

  it('deducts 10 points per error-severity forbid match', () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        rules: [
          { pattern: 'eval\\(', message: 'No eval', severity: 'error' },
        ],
      }))
      .mockReturnValueOnce('const x = eval("bad");\nconst y = eval("worse");');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    // Two matches × 10 pts each = 20 deducted → score = 80/100 = 0.8
    expect(result.score).toBe(0.8);
    expect(result.passed).toBe(false);
  });

  it('deducts 5 points per warning-severity forbid match', () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        rules: [
          { pattern: 'console\\.log', message: 'No console.log', severity: 'warning' },
        ],
      }))
      .mockReturnValueOnce('console.log("hi");');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    expect(result.score).toBe(0.95);
    expect(result.passed).toBe(true); // warnings don't fail
  });

  it('scores 1.0 when no forbid patterns match', () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        rules: [
          { pattern: 'eval\\(', message: 'No eval', severity: 'error' },
        ],
      }))
      .mockReturnValueOnce('const x = 1 + 2;');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  // ── Require mode ───────────────────────────────────────────────────

  it('deducts 10 points when a required error-severity pattern is missing', () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        rules: [
          { pattern: 'supabase\\.auth\\.getUser', message: 'Must have auth', severity: 'error', mode: 'require' },
        ],
      }))
      .mockReturnValueOnce('const data = await supabase.from("users").select("*");');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    expect(result.score).toBe(0.9); // 100 - 10 = 90 → 0.9
    expect(result.passed).toBe(false);
  });

  it('deducts 5 points when a required warning-severity pattern is missing', () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        rules: [
          { pattern: 'streaming', message: 'Should mention streaming', severity: 'warning', mode: 'require' },
        ],
      }))
      .mockReturnValueOnce('This prompt covers tool calling and memory.');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    expect(result.score).toBe(0.95);
    expect(result.passed).toBe(true);
  });

  it('scores 1.0 when all required patterns are present', () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        rules: [
          { pattern: 'supabase\\.auth\\.getUser', message: 'Must have auth', severity: 'error', mode: 'require' },
          { pattern: 'Zod', message: 'Must have Zod', severity: 'error', mode: 'require' },
        ],
      }))
      .mockReturnValueOnce('Use supabase.auth.getUser() and validate with Zod schemas.');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  // ── Mixed modes ────────────────────────────────────────────────────

  it('handles both forbid and require rules together', () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        rules: [
          { pattern: 'eval\\(', message: 'No eval', severity: 'error' },
          { pattern: 'auth', message: 'Must mention auth', severity: 'error', mode: 'require' },
        ],
      }))
      // Has eval (forbid match) but also has auth (require satisfied)
      .mockReturnValueOnce('eval("x");\nconst auth = getAuth();');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    // 1 forbid match (error) = -10 → score = 90/100 = 0.9
    expect(result.score).toBe(0.9);
    expect(result.passed).toBe(false);
  });

  it('accumulates deductions from both missing requires and forbid matches', () => {
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        rules: [
          { pattern: 'eval\\(', message: 'No eval', severity: 'error' },
          { pattern: 'auth', message: 'Must mention auth', severity: 'error', mode: 'require' },
        ],
      }))
      // Has eval (forbid match) AND missing auth (require miss)
      .mockReturnValueOnce('eval("x");');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    // 1 forbid match (-10) + 1 require miss (-10) = -20 → score = 80/100 = 0.8
    expect(result.score).toBe(0.8);
    expect(result.passed).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it('clamps score to 0 when deductions exceed 100', () => {
    const rules = Array.from({ length: 15 }, (_, i) => ({
      pattern: `missing${i}`,
      message: `Must have missing${i}`,
      severity: 'error' as const,
      mode: 'require' as const,
    }));

    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({ rules }))
      .mockReturnValueOnce('nothing here');

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    expect(result.score).toBe(0);
  });

  it('returns error result when rules file is missing', () => {
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });

    const result = runPatternScorer('test', 'file.ts', 'rules.json', 20);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.details).toHaveProperty('error');
  });
});
