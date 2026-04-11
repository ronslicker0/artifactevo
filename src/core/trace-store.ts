import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────

export type RunTrigger = 'hook' | 'cli' | 'ci' | 'manual';
export type RunStatus = 'running' | 'completed' | 'failed';

export interface RunManifest {
  run_id: string;
  artifact_id: string;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  score: number | null;
  max_score: number | null;
  trigger: RunTrigger;
}

export interface TraceIndexEntry {
  run_id: string;
  artifact_id: string;
  status: RunStatus;
  started_at: string;
  score: number | null;
  trigger: RunTrigger;
}

export interface TraceIndex {
  runs: TraceIndexEntry[];
}

export interface TraceEntry {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function runsDir(evoDir: string): string {
  return join(evoDir, 'traces', 'runs');
}

function runDirPath(evoDir: string, runId: string): string {
  return join(runsDir(evoDir), runId);
}

function manifestPath(runDir: string): string {
  return join(runDir, 'manifest.json');
}

function indexPath(evoDir: string): string {
  return join(evoDir, 'traces', 'index.json');
}

function readManifest(runDir: string): RunManifest {
  const raw = readFileSync(manifestPath(runDir), 'utf-8');
  return JSON.parse(raw) as RunManifest;
}

function writeManifest(runDir: string, manifest: RunManifest): void {
  writeFileSync(manifestPath(runDir), JSON.stringify(manifest, null, 2), 'utf-8');
}

function loadIndex(evoDir: string): TraceIndex {
  const p = indexPath(evoDir);
  if (!existsSync(p)) {
    return { runs: [] };
  }
  const raw = readFileSync(p, 'utf-8');
  return JSON.parse(raw) as TraceIndex;
}

function saveIndex(evoDir: string, index: TraceIndex): void {
  const p = indexPath(evoDir);
  const dir = join(evoDir, 'traces');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(p, JSON.stringify(index, null, 2), 'utf-8');
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Generate a unique run ID in the format: run-YYYYMMDDHHMMSS-<artifact>-<4hex>
 */
export function generateRunId(artifactId: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const hex = randomBytes(2).toString('hex');
  // Sanitize artifact ID for filesystem safety
  const safe = artifactId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
  return `run-${ts}-${safe}-${hex}`;
}

/**
 * Initialize a new run. Creates the run directory and manifest.
 * Returns the run ID and absolute run directory path.
 */
export function initRun(
  evoDir: string,
  artifactId: string,
  trigger: RunTrigger
): { runId: string; runDir: string } {
  const runId = generateRunId(artifactId);
  const runDir = runDirPath(evoDir, runId);

  mkdirSync(runDir, { recursive: true });

  const manifest: RunManifest = {
    run_id: runId,
    artifact_id: artifactId,
    status: 'running',
    started_at: new Date().toISOString(),
    completed_at: null,
    duration_seconds: null,
    score: null,
    max_score: null,
    trigger,
  };

  writeManifest(runDir, manifest);

  // Update index
  const index = loadIndex(evoDir);
  index.runs.push({
    run_id: runId,
    artifact_id: artifactId,
    status: 'running',
    started_at: manifest.started_at,
    score: null,
    trigger,
  });
  saveIndex(evoDir, index);

  return { runId, runDir };
}

/**
 * Finalize a completed run. Updates manifest with score and duration, writes scorecard.
 */
export function finalizeRun(
  evoDir: string,
  runId: string,
  score: number,
  maxScore: number,
  scorecard: Record<string, unknown>
): void {
  const runDir = runDirPath(evoDir, runId);

  if (!existsSync(manifestPath(runDir))) {
    throw new Error(`Run not found: ${runId}`);
  }

  const manifest = readManifest(runDir);
  const startedAt = new Date(manifest.started_at);
  const completedAt = new Date();

  manifest.status = 'completed';
  manifest.completed_at = completedAt.toISOString();
  manifest.duration_seconds = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);
  manifest.score = score;
  manifest.max_score = maxScore;

  writeManifest(runDir, manifest);

  // Write scorecard
  writeFileSync(
    join(runDir, 'scorecard.json'),
    JSON.stringify(scorecard, null, 2),
    'utf-8'
  );

  // Update index entry
  const index = loadIndex(evoDir);
  const indexEntry = index.runs.find((r) => r.run_id === runId);
  if (indexEntry) {
    indexEntry.status = 'completed';
    indexEntry.score = score;
  }
  saveIndex(evoDir, index);
}

/**
 * Append a trace entry to a run's trace.jsonl file.
 */
export function appendTrace(runDir: string, entry: TraceEntry): void {
  const tracePath = join(runDir, 'trace.jsonl');
  appendFileSync(tracePath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Get the run ID of the currently active (status=running) run, or null.
 */
export function getActiveRunId(evoDir: string): string | null {
  const index = loadIndex(evoDir);
  const running = index.runs.find((r) => r.status === 'running');
  return running?.run_id ?? null;
}

/**
 * List runs from the trace index, optionally filtered.
 */
export function listRuns(
  evoDir: string,
  filter?: { artifact_id?: string; status?: RunStatus }
): TraceIndexEntry[] {
  const index = loadIndex(evoDir);
  let runs = index.runs;

  if (filter?.artifact_id) {
    runs = runs.filter((r) => r.artifact_id === filter.artifact_id);
  }
  if (filter?.status) {
    runs = runs.filter((r) => r.status === filter.status);
  }

  // Most recent first
  return [...runs].reverse();
}
