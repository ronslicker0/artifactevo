import type { ArchiveEntry } from '../core/archive.js';

// ── Selection Context ───────────────────────────────────────────────────

interface SelectionContext {
  archive: ArchiveEntry[];
  artifactId: string;
}

// ── Parent Selection ────────────────────────────────────────────────────

/**
 * Select the best-scoring archive entry for a given artifact.
 * Returns null if no scored entries exist for this artifact.
 */
export function selectParent(ctx: SelectionContext): ArchiveEntry | null {
  const candidates = ctx.archive.filter(
    (e) => e.artifact === ctx.artifactId && e.score !== null
  );

  if (candidates.length === 0) return null;

  // Sort by score descending, then by genid descending (most recent wins ties)
  candidates.sort((a, b) => {
    const scoreDiff = (b.score as number) - (a.score as number);
    if (scoreDiff !== 0) return scoreDiff;
    return b.genid - a.genid;
  });

  return candidates[0];
}

// ── Challenge Selection ─────────────────────────────────────────────────

/**
 * Select the challenge with the lowest recent score (least-mastered).
 * Returns null if no challenges are configured.
 *
 * @param challenges - List of available challenge identifiers
 * @param archive - Full archive entries
 * @param artifactId - The artifact to evaluate challenges for
 */
export function selectChallenge(
  challenges: string[],
  archive: ArchiveEntry[],
  artifactId: string
): string | null {
  if (challenges.length === 0) return null;

  const artifactEntries = archive.filter(
    (e) => e.artifact === artifactId && e.challenge !== null && e.score !== null
  );

  // Build a map of challenge -> most recent score
  const recentScores = new Map<string, number>();

  for (const entry of artifactEntries) {
    const challenge = entry.challenge as string;
    // Later entries overwrite earlier ones (entries are chronological)
    recentScores.set(challenge, entry.score as number);
  }

  // Find the challenge with the lowest recent score
  // Challenges never attempted get a score of -Infinity (prioritized)
  let bestChallenge: string | null = null;
  let lowestScore = Infinity;

  for (const challenge of challenges) {
    const score = recentScores.get(challenge) ?? -Infinity;
    if (score < lowestScore) {
      lowestScore = score;
      bestChallenge = challenge;
    }
  }

  return bestChallenge;
}
