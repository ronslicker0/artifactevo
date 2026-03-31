import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Constants ───────────────────────────────────────────────────────────

const LOCK_FILE = 'lock';
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

interface LockInfo {
  pid: number;
  timestamp: string;
}

// ── Lock Path ───────────────────────────────────────────────────────────

function lockPath(evoDir: string): string {
  return join(evoDir, LOCK_FILE);
}

// ── Stale Check ─────────────────────────────────────────────────────────

function isStale(info: LockInfo): boolean {
  const lockTime = new Date(info.timestamp).getTime();
  return Date.now() - lockTime > STALE_THRESHOLD_MS;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Attempt to acquire a file-based lock.
 * Returns true if the lock was successfully acquired, false if already locked.
 * Cleans up stale locks automatically (>30 min old).
 */
export function acquireLock(evoDir: string): boolean {
  const path = lockPath(evoDir);

  // Check for existing lock
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const info = JSON.parse(raw) as LockInfo;

      if (isStale(info)) {
        // Stale lock — clean it up
        unlinkSync(path);
      } else {
        // Active lock — cannot acquire
        return false;
      }
    } catch {
      // Malformed lock file — remove and proceed
      unlinkSync(path);
    }
  }

  // Ensure directory exists
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write lock file
  const info: LockInfo = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(info, null, 2), 'utf-8');

  return true;
}

/**
 * Release the lock by removing the lock file.
 */
export function releaseLock(evoDir: string): void {
  const path = lockPath(evoDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Check if the lock is currently held (and not stale).
 */
export function isLocked(evoDir: string): boolean {
  const path = lockPath(evoDir);
  if (!existsSync(path)) return false;

  try {
    const raw = readFileSync(path, 'utf-8');
    const info = JSON.parse(raw) as LockInfo;
    return !isStale(info);
  } catch {
    return false;
  }
}

/**
 * Execute a function while holding the lock.
 * Returns null if the lock could not be acquired.
 * Always releases the lock when done, even on error.
 */
export async function withLock<T>(
  evoDir: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!acquireLock(evoDir)) {
    return null;
  }

  try {
    return await fn();
  } finally {
    releaseLock(evoDir);
  }
}
