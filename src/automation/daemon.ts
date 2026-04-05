import type { EvoConfig } from '../core/config.js';
import { acquireLock, releaseLock } from './lock.js';
import { getPending, clearPending, hasPending } from './pending.js';
import { evolve } from '../loops/evolve.js';

// ── ANSI Colors ─────────────────────────────────────────────────────────

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

// ── Schedule Parsing ────────────────────────────────────────────────────

/**
 * Parse a simple cron-like schedule to a millisecond interval.
 * Supports: "* /N * * * *" (every N minutes) pattern.
 * Falls back to cooldown_minutes from config.
 */
function parseScheduleToMs(schedule: string | undefined, fallbackMinutes: number): number {
  if (!schedule) return fallbackMinutes * 60 * 1000;

  // Match simple "*/N * * * *" pattern for every N minutes
  const match = schedule.match(/^\*\/(\d+)\s/);
  if (match) {
    const minutes = parseInt(match[1], 10);
    if (minutes > 0) return minutes * 60 * 1000;
  }

  // Fallback to cooldown
  return fallbackMinutes * 60 * 1000;
}

// ── PID File ────────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function pidPath(evoDir: string): string {
  return join(evoDir, 'daemon.pid');
}

function writePid(evoDir: string): void {
  writeFileSync(pidPath(evoDir), String(process.pid), 'utf-8');
}

function removePid(evoDir: string): void {
  const path = pidPath(evoDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Read the daemon PID from the PID file, or null if not running.
 */
export function readDaemonPid(evoDir: string): number | null {
  const path = pidPath(evoDir);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

// ── Daemon ──────────────────────────────────────────────────────────────

/**
 * Start the automation daemon.
 *
 * Polls for pending runs on a schedule and processes them.
 * Handles SIGTERM/SIGINT for graceful shutdown.
 */
export async function startDaemon(config: EvoConfig, evoDir: string): Promise<void> {
  const intervalMs = parseScheduleToMs(
    config.automation.daemon_schedule,
    config.automation.cooldown_minutes,
  );
  const batchSize = config.evolution.budget_per_session;

  let running = true;

  // Graceful shutdown
  const shutdown = (): void => {
    console.log(dim('\nDaemon shutting down...'));
    running = false;
    releaseLock(evoDir);
    removePid(evoDir);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Write PID file
  writePid(evoDir);

  console.log(bold('Kultiv Daemon'));
  console.log(dim(`  PID: ${process.pid}`));
  console.log(dim(`  Interval: ${intervalMs / 1000}s`));
  console.log(dim(`  Batch size: ${batchSize}`));
  console.log('');

  while (running) {
    try {
      await tick(config, evoDir, batchSize);
    } catch (err) {
      console.error(red(`Daemon tick error: ${String(err)}`));
    }

    // Wait for next tick
    if (running) {
      await sleep(intervalMs);
    }
  }

  removePid(evoDir);
  console.log(green('Daemon stopped cleanly.'));
}

async function tick(config: EvoConfig, evoDir: string, batchSize: number): Promise<void> {
  // Try to acquire lock
  if (!acquireLock(evoDir)) {
    console.log(dim(`[${timestamp()}] Skipping — lock held by another process`));
    return;
  }

  try {
    // Check pending queue
    if (!hasPending(evoDir)) {
      console.log(dim(`[${timestamp()}] No pending runs`));
      return;
    }

    const pending = getPending(evoDir);
    console.log(green(`[${timestamp()}] Processing ${pending.length} pending run(s)`));

    // Group by artifact for efficient processing
    const artifactIds = [...new Set(pending.map((p) => p.artifactId))];

    for (const artifactId of artifactIds) {
      await evolve(config, {
        budget: batchSize,
        artifactId,
      });
    }

    // Clear processed pending items
    clearPending(evoDir, pending.map((p) => p.runId));
  } finally {
    releaseLock(evoDir);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
