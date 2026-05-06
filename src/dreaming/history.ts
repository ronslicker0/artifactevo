import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { DreamHistoryEntry } from './types.js';

/**
 * Append-only JSONL of every dream run for this Kultiv project. Used to
 * decide cooldown windows and to power `kultiv dream list`.
 */
export class DreamHistory {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  append(entry: DreamHistoryEntry): void {
    ensureDir(dirname(this.filePath));
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  list(limit = 50): DreamHistoryEntry[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf-8');
    const out: DreamHistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as DreamHistoryEntry);
      } catch {
        // skip malformed
      }
    }
    return out.slice(-limit).reverse(); // most recent first
  }

  lastCompletedAt(): Date | null {
    const recent = this.list(20).find((e) => e.status === 'completed');
    if (!recent || !recent.completedAt) return null;
    const d = new Date(recent.completedAt);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Mark a previously appended entry as applied. Rewrites the file (small —
   * we cap history to at most a few hundred entries in practice).
   */
  markApplied(id: string, appliedAt: string): void {
    if (!existsSync(this.filePath)) return;
    const raw = readFileSync(this.filePath, 'utf-8');
    const lines = raw.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        out.push('');
        continue;
      }
      try {
        const entry = JSON.parse(trimmed) as DreamHistoryEntry;
        if (entry.id === id) {
          entry.applied = true;
          entry.appliedAt = appliedAt;
        }
        out.push(JSON.stringify(entry));
      } catch {
        out.push(trimmed);
      }
    }
    writeFileSync(this.filePath, out.join('\n'), 'utf-8');
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}
