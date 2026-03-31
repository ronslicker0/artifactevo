import type { ArchiveEntry } from '../core/archive.js';

// ── Anti-Pattern Types ──────────────────────────────────────────────────

export interface AntiPattern {
  type: 'type_fixation' | 'plateau' | 'saturation' | 'overfitting' | 'bloat';
  message: string;
  severity: 'low' | 'medium' | 'high';
  suggestion: string;
}

// ── Detection Logic ─────────────────────────────────────────────────────

/**
 * Detect heuristic anti-patterns from archive data.
 * Pure arithmetic on archive entries — zero LLM tokens consumed.
 *
 * @param entries - All archive entries
 * @param artifactId - The artifact to analyze
 */
export function detectAntiPatterns(
  entries: ArchiveEntry[],
  artifactId: string
): AntiPattern[] {
  const artifactEntries = entries.filter((e) => e.artifact === artifactId);
  const patterns: AntiPattern[] = [];

  if (artifactEntries.length < 3) {
    return patterns;
  }

  detectTypeFixation(artifactEntries, patterns);
  detectPlateau(artifactEntries, patterns);
  detectSaturation(artifactEntries, patterns);
  detectOverfitting(artifactEntries, patterns);
  detectBloat(artifactEntries, patterns);

  return patterns;
}

// ── Type Fixation ───────────────────────────────────────────────────────

/**
 * >60% of last 5 mutations use the same type.
 */
function detectTypeFixation(entries: ArchiveEntry[], patterns: AntiPattern[]): void {
  const recent = entries.slice(-5);
  if (recent.length < 5) return;

  const typeCounts = new Map<string, number>();
  for (const entry of recent) {
    const count = typeCounts.get(entry.mutation_type) ?? 0;
    typeCounts.set(entry.mutation_type, count + 1);
  }

  for (const [type, count] of typeCounts) {
    if (count / recent.length > 0.6) {
      patterns.push({
        type: 'type_fixation',
        message: `${count} of last ${recent.length} mutations used ${type}`,
        severity: 'medium',
        suggestion: `Diversify mutation types — try a different approach than ${type}`,
      });
      break;
    }
  }
}

// ── Plateau ─────────────────────────────────────────────────────────────

/**
 * Best score unchanged across last 5 runs.
 */
function detectPlateau(entries: ArchiveEntry[], patterns: AntiPattern[]): void {
  const scored = entries.filter((e) => e.score !== null);
  if (scored.length < 5) return;

  const lastFive = scored.slice(-5);
  const scores = lastFive.map((e) => e.score as number);
  const best = Math.max(...scores);

  // Check if all entries before the window also had this best score
  const priorScored = scored.slice(0, -5);
  if (priorScored.length === 0) return;

  const priorBest = Math.max(...priorScored.map((e) => e.score as number));

  if (best <= priorBest) {
    patterns.push({
      type: 'plateau',
      message: `Best score (${best}) has not improved across last 5 scored runs (prior best: ${priorBest})`,
      severity: 'high',
      suggestion: 'Try RESTRUCTURE to fundamentally reorganize the artifact',
    });
  }
}

// ── Saturation ──────────────────────────────────────────────────────────

/**
 * Same challenge scored 100% for 3+ consecutive runs.
 */
function detectSaturation(entries: ArchiveEntry[], patterns: AntiPattern[]): void {
  const withChallenges = entries.filter(
    (e) => e.challenge !== null && e.score !== null && e.max_score > 0
  );

  if (withChallenges.length < 3) return;

  // Group consecutive entries by challenge, track perfect streaks
  const challengeStreaks = new Map<string, number>();

  // Walk backwards to find current streaks
  for (let i = withChallenges.length - 1; i >= 0; i--) {
    const entry = withChallenges[i];
    const challenge = entry.challenge as string;
    const isPerfect = (entry.score as number) >= entry.max_score;

    if (!challengeStreaks.has(challenge)) {
      // First time seeing this challenge from the end
      challengeStreaks.set(challenge, isPerfect ? 1 : 0);
    } else {
      const current = challengeStreaks.get(challenge) as number;
      if (current > 0 && isPerfect) {
        // Active streak, still perfect
        challengeStreaks.set(challenge, current + 1);
      } else if (current > 0 && !isPerfect) {
        // Streak broken — negate to finalize
        challengeStreaks.set(challenge, -current);
      }
      // If already finalized (negative or zero), skip
    }
  }

  for (const [challenge, streak] of challengeStreaks) {
    const actualStreak = streak > 0 ? streak : 0;
    if (actualStreak >= 3) {
      patterns.push({
        type: 'saturation',
        message: `Challenge "${challenge}" scored 100% for ${actualStreak} consecutive runs`,
        severity: 'low',
        suggestion: 'Consider adding harder challenges or removing this saturated one',
      });
    }
  }
}

// ── Overfitting ─────────────────────────────────────────────────────────

/**
 * Improved on one challenge but regressed on another in the same session.
 * Detected by comparing per-challenge score trends in recent entries.
 */
function detectOverfitting(entries: ArchiveEntry[], patterns: AntiPattern[]): void {
  const scored = entries.filter(
    (e) => e.score !== null && e.challenge !== null
  );

  if (scored.length < 4) return;

  // Look at the last 10 entries and check for cross-challenge regression
  const recent = scored.slice(-10);

  // Build per-challenge score history
  const challengeHistory = new Map<string, Array<{ score: number; genid: number }>>();

  for (const entry of recent) {
    const challenge = entry.challenge as string;
    const history = challengeHistory.get(challenge) ?? [];
    history.push({ score: entry.score as number, genid: entry.genid });
    challengeHistory.set(challenge, history);
  }

  // Check if any challenge improved while another regressed
  const improving: string[] = [];
  const regressing: string[] = [];

  for (const [challenge, history] of challengeHistory) {
    if (history.length < 2) continue;
    const last = history[history.length - 1].score;
    const prev = history[history.length - 2].score;

    if (last > prev) improving.push(challenge);
    if (last < prev) regressing.push(challenge);
  }

  if (improving.length > 0 && regressing.length > 0) {
    patterns.push({
      type: 'overfitting',
      message: `Improved on [${improving.join(', ')}] but regressed on [${regressing.join(', ')}]`,
      severity: 'high',
      suggestion:
        'Mutation may be too specific to one challenge — use REPHRASE or ADD_RULE for more general improvements',
    });
  }
}

// ── Bloat ───────────────────────────────────────────────────────────────

/**
 * Artifact line count growing without score improvement.
 * Checks mutation_desc for line count mentions.
 */
function detectBloat(entries: ArchiveEntry[], patterns: AntiPattern[]): void {
  const scored = entries.filter((e) => e.score !== null);
  if (scored.length < 3) return;

  const recent = scored.slice(-5);

  // Extract line counts from mutation descriptions (pattern: "N lines" or "lineCount: N")
  const lineCounts: number[] = [];
  for (const entry of recent) {
    const lineMatch = entry.mutation_desc.match(/(\d+)\s*lines?/i);
    if (lineMatch) {
      lineCounts.push(parseInt(lineMatch[1], 10));
    }
  }

  if (lineCounts.length < 2) return;

  const firstLineCount = lineCounts[0];
  const lastLineCount = lineCounts[lineCounts.length - 1];
  const lineGrowth = lastLineCount - firstLineCount;

  // Check if lines grew by >20% but score did not improve
  if (firstLineCount > 0 && lineGrowth / firstLineCount > 0.2) {
    const firstScore = recent[0].score as number;
    const lastScore = recent[recent.length - 1].score as number;

    if (lastScore <= firstScore) {
      patterns.push({
        type: 'bloat',
        message: `Artifact grew from ~${firstLineCount} to ~${lastLineCount} lines without score improvement`,
        severity: 'medium',
        suggestion: 'Try SIMPLIFY to reduce artifact size while maintaining quality',
      });
    }
  }
}
