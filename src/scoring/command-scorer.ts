import { execSync } from 'node:child_process';
import type { EvaluatorResult } from './chain-runner.js';

// ── Error Count Patterns ─────────────────────────────────────────────────

/**
 * Patterns to extract error/failure counts from command output.
 * Each pattern has a regex and a group index for the count.
 */
const ERROR_COUNT_PATTERNS: Array<{ regex: RegExp; group: number }> = [
  // "Found 5 errors" / "Found 5 error(s)"
  { regex: /Found\s+(\d+)\s+errors?/i, group: 1 },
  // "5 errors" / "5 error(s)"
  { regex: /(\d+)\s+errors?/i, group: 1 },
  // "5 failures" / "5 failure(s)"
  { regex: /(\d+)\s+failures?/i, group: 1 },
  // "5 failed"
  { regex: /(\d+)\s+failed/i, group: 1 },
  // "5 warnings"
  { regex: /(\d+)\s+warnings?/i, group: 1 },
  // "Tests: X passed, Y failed"
  { regex: /(\d+)\s+passed.*?(\d+)\s+failed/i, group: 2 },
];

/**
 * Try to parse an error count from combined output.
 * Returns null if no recognizable pattern is found.
 */
function parseErrorCount(output: string): number | null {
  for (const { regex, group } of ERROR_COUNT_PATTERNS) {
    const match = regex.exec(output);
    if (match && match[group]) {
      const count = parseInt(match[group], 10);
      if (!isNaN(count)) return count;
    }
  }
  return null;
}

// ── Command Scorer ───────────────────────────────────────────────────────

const TIMEOUT_MS = 120_000;

/**
 * Run a shell command and score based on exit code and output analysis.
 *
 * - Exit 0: full score (1/1)
 * - Exit non-zero: attempt to parse error counts for partial credit,
 *   otherwise 0/1
 */
export function runCommandScorer(
  name: string,
  command: string,
  projectRoot: string
): EvaluatorResult {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const output = execSync(command, {
      cwd: projectRoot,
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // Prevent shell window popups on Windows
      windowsHide: true,
    });
    stdout = output;
    exitCode = 0;
  } catch (err: unknown) {
    const execError = err as {
      status?: number | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    exitCode = execError.status ?? 1;
    stdout = execError.stdout ?? '';
    stderr = execError.stderr ?? '';
  }

  const combinedOutput = `${stdout}\n${stderr}`.trim();

  // Full pass on exit 0
  if (exitCode === 0) {
    return {
      name,
      score: 1,
      max: 1,
      weight: 1,
      details: {
        command,
        exit_code: exitCode,
        stdout: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 2000),
      },
      passed: true,
    };
  }

  // Attempt partial credit from error count parsing
  const errorCount = parseErrorCount(combinedOutput);
  let score = 0;
  let max = 1;

  if (errorCount !== null && errorCount > 0) {
    // Use a diminishing scale: fewer errors = higher partial credit
    // score = max(0, 1 - errorCount/100) so up to 100 errors scales linearly
    score = Math.max(0, Math.round((1 - errorCount / 100) * 100) / 100);
    max = 1;
  }

  return {
    name,
    score,
    max,
    weight: 1,
    details: {
      command,
      exit_code: exitCode,
      error_count: errorCount,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
    },
    passed: false,
  };
}
