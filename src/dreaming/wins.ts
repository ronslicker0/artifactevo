import { Archive } from '../core/archive.js';

export interface DreamWinSummary {
  artifact: string;
  mutationType: string;
  fitnessDelta: number | null;
  timestamp: string;
  description?: string;
}

/**
 * Extract recent winning mutations from the Kultiv archive — useful as a
 * cross-session signal for the dreamer. Returns up to `limit` entries with
 * status='success', most recent first, with a per-artifact fitness delta
 * computed against the previous scored entry for the same artifact.
 */
export function readRecentWins(archivePath: string, limit = 20): DreamWinSummary[] {
  const archive = new Archive(archivePath);
  archive.load();
  const all = archive.getAll();

  // Group by artifact for delta computation.
  const byArtifact = new Map<string, typeof all[number][]>();
  for (const e of all) {
    const list = byArtifact.get(e.artifact);
    if (list) list.push(e);
    else byArtifact.set(e.artifact, [e]);
  }

  const wins: DreamWinSummary[] = [];
  for (const e of all) {
    if (e.status !== 'success') continue;
    const list = byArtifact.get(e.artifact) ?? [];
    const idx = list.indexOf(e);
    let prevScored: typeof e | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      if (list[i].score !== null) {
        prevScored = list[i];
        break;
      }
    }
    const delta =
      e.score !== null && prevScored && prevScored.score !== null
        ? +(e.score - prevScored.score).toFixed(3)
        : null;
    wins.push({
      artifact: e.artifact,
      mutationType: e.mutation_type,
      fitnessDelta: delta,
      timestamp: e.timestamp,
      description: e.mutation_desc,
    });
  }

  // Most recent first, capped.
  return wins
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}
