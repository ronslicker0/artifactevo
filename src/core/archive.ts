import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export type ArchiveStatus = 'baseline' | 'success' | 'regression' | 'crash' | 'neutral';

export interface ArchiveEntry {
  genid: number;
  artifact: string;
  parent: number | null;
  score: number | null;
  max_score: number;
  challenge: string | null;
  run_id: string | null;
  diff: string | null;
  mutation_type: string;
  mutation_desc: string;
  status: ArchiveStatus;
  timestamp: string;
  token_cost: number | null;
  automated: boolean;
}

export type ArchiveFilter = Partial<Pick<ArchiveEntry, 'artifact' | 'status' | 'run_id' | 'automated'>>;

// ── Archive Class ────────────────────────────────────────────────────────

export class Archive {
  private entries: ArchiveEntry[] = [];
  private filePath: string;
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load all entries from the JSONL file. Creates the file if it does not exist.
   */
  load(): void {
    if (!existsSync(this.filePath)) {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, '', 'utf-8');
      this.entries = [];
      this.loaded = true;
      return;
    }

    const raw = readFileSync(this.filePath, 'utf-8');
    this.entries = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      try {
        const entry = JSON.parse(trimmed) as ArchiveEntry;
        this.entries.push(entry);
      } catch {
        // Skip malformed lines — log nothing, keep going
      }
    }

    this.loaded = true;
  }

  /**
   * Append an entry to the archive. Writes immediately to disk.
   */
  append(entry: ArchiveEntry): void {
    this.ensureLoaded();
    this.entries.push(entry);

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  /**
   * Query entries matching a partial filter.
   */
  query(filter: ArchiveFilter): ArchiveEntry[] {
    this.ensureLoaded();

    return this.entries.filter((entry) => {
      if (filter.artifact !== undefined && entry.artifact !== filter.artifact) return false;
      if (filter.status !== undefined && entry.status !== filter.status) return false;
      if (filter.run_id !== undefined && entry.run_id !== filter.run_id) return false;
      if (filter.automated !== undefined && entry.automated !== filter.automated) return false;
      return true;
    });
  }

  /**
   * Get all entries for a specific artifact.
   */
  getByArtifact(artifactId: string): ArchiveEntry[] {
    return this.query({ artifact: artifactId });
  }

  /**
   * Get the best score recorded for an artifact.
   * Returns null if no scored entries exist.
   */
  getBestScore(artifactId: string): number | null {
    const entries = this.getByArtifact(artifactId).filter(
      (e) => e.score !== null
    );

    if (entries.length === 0) return null;

    return Math.max(...entries.map((e) => e.score as number));
  }

  /**
   * Get the last N scores for an artifact, most recent first.
   */
  getScoreHistory(artifactId: string, n: number): number[] {
    return this.getByArtifact(artifactId)
      .filter((e) => e.score !== null)
      .slice(-n)
      .reverse()
      .map((e) => e.score as number);
  }

  /**
   * Get the N most recent entries across all artifacts.
   */
  getRecentEntries(n: number): ArchiveEntry[] {
    this.ensureLoaded();
    return this.entries.slice(-n).reverse();
  }

  /**
   * Get the next generation ID (max genid + 1, or 1 if empty).
   */
  getNextGenId(): number {
    this.ensureLoaded();

    if (this.entries.length === 0) return 1;

    const maxGenId = Math.max(...this.entries.map((e) => e.genid));
    return maxGenId + 1;
  }

  /**
   * Get all loaded entries (read-only copy).
   */
  getAll(): ReadonlyArray<ArchiveEntry> {
    this.ensureLoaded();
    return [...this.entries];
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load();
    }
  }
}
