import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

interface PendingEntry {
  runId: string;
  artifactId: string;
  timestamp: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function pendingDir(evoDir: string): string {
  return join(evoDir, 'pending');
}

function ensurePendingDir(evoDir: string): void {
  const dir = pendingDir(evoDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Add a pending evolution run to the queue.
 * Writes a JSON file to `.evo/pending/<run-id>.json`.
 */
export function addPending(evoDir: string, runId: string, artifactId: string): void {
  ensurePendingDir(evoDir);

  const entry: PendingEntry = {
    runId,
    artifactId,
    timestamp: new Date().toISOString(),
  };

  const filePath = join(pendingDir(evoDir), `${runId}.json`);
  writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
}

/**
 * Get all pending evolution runs, sorted by timestamp (oldest first).
 */
export function getPending(
  evoDir: string,
): Array<{ runId: string; artifactId: string; timestamp: string }> {
  const dir = pendingDir(evoDir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const entries: PendingEntry[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const entry = JSON.parse(raw) as PendingEntry;
      entries.push(entry);
    } catch {
      // Skip malformed files
    }
  }

  // Sort by timestamp ascending
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return entries;
}

/**
 * Clear specific pending runs by their run IDs.
 */
export function clearPending(evoDir: string, runIds: string[]): void {
  const dir = pendingDir(evoDir);
  if (!existsSync(dir)) return;

  const idSet = new Set(runIds);

  for (const runId of idSet) {
    const filePath = join(dir, `${runId}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

/**
 * Check if there are any pending runs in the queue.
 */
export function hasPending(evoDir: string): boolean {
  const dir = pendingDir(evoDir);
  if (!existsSync(dir)) return false;

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.length > 0;
}
