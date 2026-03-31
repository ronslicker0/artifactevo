import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { acquireLock, releaseLock } from './lock.js';
import { getPending, clearPending } from './pending.js';
import { evolve } from '../loops/evolve.js';

// ── ANSI Colors ─────────────────────────────────────────────────────────

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;

// ── Types ────────────────────────────────────────────────────────────────

interface LastAutoRun {
  timestamp: string;
  artifactIds: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function lastRunPath(evoDir: string): string {
  return join(evoDir, 'last-auto-run.json');
}

function readLastRun(evoDir: string): LastAutoRun | null {
  const path = lastRunPath(evoDir);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as LastAutoRun;
  } catch {
    return null;
  }
}

function writeLastRun(evoDir: string, artifactIds: string[]): void {
  const info: LastAutoRun = {
    timestamp: new Date().toISOString(),
    artifactIds,
  };
  writeFileSync(lastRunPath(evoDir), JSON.stringify(info, null, 2), 'utf-8');
}

// ── Hook Trigger ────────────────────────────────────────────────────────

/**
 * Detached process spawned by hooks for immediate evolution after an agent run.
 *
 * Flow:
 * 1. Check cooldown (skip if too recent)
 * 2. Try to acquire lock (exit if daemon is running)
 * 3. Read pending queue
 * 4. Load config
 * 5. Run evolve() with trigger_after budget
 * 6. Write last-auto-run timestamp
 * 7. Clear processed pending items
 * 8. Release lock
 */
export async function hookTrigger(evoDir: string, configPath: string): Promise<void> {
  // 1. Check cooldown
  const config = loadConfig(configPath);
  const cooldownMs = config.automation.cooldown_minutes * 60 * 1000;
  const lastRun = readLastRun(evoDir);

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.timestamp).getTime();
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
      console.log(dim(`Hook trigger: cooldown active (${remaining}s remaining). Skipping.`));
      return;
    }
  }

  // 2. Try to acquire lock
  if (!acquireLock(evoDir)) {
    console.log(yellow('Hook trigger: lock held (daemon or another trigger running). Skipping.'));
    return;
  }

  try {
    // 3. Read pending queue
    const pending = getPending(evoDir);
    const artifactIds = pending.length > 0
      ? [...new Set(pending.map((p) => p.artifactId))]
      : undefined;

    // 4-5. Run evolve for each artifact (or all if no specific pending)
    const budget = config.automation.trigger_after;

    if (artifactIds && artifactIds.length > 0) {
      for (const artifactId of artifactIds) {
        await evolve(config, {
          budget,
          artifactId,
        });
      }
    } else {
      await evolve(config, { budget });
    }

    // 6. Write last-auto-run
    writeLastRun(evoDir, artifactIds ?? Object.keys(config.artifacts));

    // 7. Clear processed pending items
    if (pending.length > 0) {
      clearPending(evoDir, pending.map((p) => p.runId));
    }
  } finally {
    // 8. Release lock
    releaseLock(evoDir);
  }
}
