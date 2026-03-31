// ── Plateau Detection ───────────────────────────────────────────────────

export interface PlateauResult {
  detected: boolean;
  windowSize: number;
  bestRecent: number;
  bestPrior: number;
  suggestion: string | null;
}

/**
 * Detect score plateaus using a sliding window comparison.
 *
 * Compares the best score in the most recent `windowSize` entries
 * against the best score in all entries before the window.
 *
 * A plateau is detected when:
 * 1. The improvement from prior best to recent best is less than 2%, OR
 * 2. The variance within the window is very low (< 1)
 *
 * @param history - Score history entries (oldest first)
 * @param windowSize - Number of recent entries to compare
 */
export function detectPlateau(
  history: Array<{ score: number | null }>,
  windowSize: number
): PlateauResult {
  // Filter out null scores
  const scores = history
    .map((h) => h.score)
    .filter((s): s is number => s !== null);

  // Not enough data to detect a plateau
  if (scores.length < windowSize + 1) {
    return {
      detected: false,
      windowSize,
      bestRecent: scores.length > 0 ? Math.max(...scores.slice(-windowSize)) : 0,
      bestPrior: 0,
      suggestion: null,
    };
  }

  const recentWindow = scores.slice(-windowSize);
  const priorScores = scores.slice(0, -windowSize);

  const bestRecent = Math.max(...recentWindow);
  const bestPrior = priorScores.length > 0 ? Math.max(...priorScores) : 0;

  // Check for improvement stall (< 2% improvement)
  const improvementRatio =
    bestPrior > 0 ? (bestRecent - bestPrior) / bestPrior : bestRecent > 0 ? 1 : 0;
  const improvementStall = improvementRatio < 0.02;

  // Check for low variance within window
  const mean = recentWindow.reduce((sum, s) => sum + s, 0) / recentWindow.length;
  const variance =
    recentWindow.reduce((sum, s) => sum + (s - mean) ** 2, 0) / recentWindow.length;
  const lowVariance = variance < 1;

  const detected = improvementStall || lowVariance;

  return {
    detected,
    windowSize,
    bestRecent,
    bestPrior,
    suggestion: detected
      ? 'Try RESTRUCTURE or SIMPLIFY to break plateau'
      : null,
  };
}
