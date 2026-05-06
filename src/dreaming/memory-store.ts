import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { join, relative, basename } from 'node:path';
import type { MemorySnapshot } from './types.js';

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_INDEX_FILE = 'MEMORY.md';
const DEFAULT_PROMOTABLE_PREFIXES = ['user', 'feedback', 'project', 'reference', 'LONG_TERM'];

// ── Public API ──────────────────────────────────────────────────────────

export interface ReadMemoryOptions {
  /** Filename of the index. Default: MEMORY.md */
  indexFile?: string;
  /** Per-file char cap to keep prompts bounded. Default: 20,000 */
  maxCharsPerFile?: number;
  /** Topic-file prefix allowlist (e.g. ['feedback','project']). Empty = all .md */
  topicPrefixes?: string[];
}

/**
 * Read the active memory tier rooted at `rootDir`.
 *
 * Reads MEMORY.md (the index) plus every other .md file in the directory whose
 * filename matches one of the allowed prefixes. Sub-directories are ignored.
 *
 * Returns null if the index file is missing — a dream can't run without one.
 */
export function readMemory(rootDir: string, options: ReadMemoryOptions = {}): MemorySnapshot | null {
  const indexFile = options.indexFile ?? DEFAULT_INDEX_FILE;
  const maxChars = options.maxCharsPerFile ?? 20_000;
  const prefixes = options.topicPrefixes ?? DEFAULT_PROMOTABLE_PREFIXES;

  if (!existsSync(rootDir)) return null;

  const indexPath = join(rootDir, indexFile);
  if (!existsSync(indexPath)) return null;

  const indexContent = safeReadCapped(indexPath, maxChars);
  let totalChars = indexContent.length;

  const topicFiles: MemorySnapshot['topicFiles'] = [];
  for (const entry of readdirSync(rootDir)) {
    if (entry === indexFile) continue;
    if (!entry.endsWith('.md')) continue;
    if (!matchesPrefix(entry, prefixes)) continue;
    const fullPath = join(rootDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const content = safeReadCapped(fullPath, maxChars);
    topicFiles.push({
      path: fullPath,
      relativePath: relative(rootDir, fullPath),
      content,
    });
    totalChars += content.length;
  }

  // Stable order: index first, then alphabetical topic files.
  topicFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    rootDir,
    indexPath,
    indexContent,
    topicFiles,
    totalChars,
  };
}

/**
 * Render a memory snapshot as a single text block suitable for inclusion
 * in an LLM prompt. Each file is fenced with a clear header so the LLM can
 * later target individual files in its proposal.
 */
export function renderSnapshotForPrompt(snapshot: MemorySnapshot): string {
  const parts: string[] = [];
  parts.push(`### MEMORY INDEX (${basename(snapshot.indexPath)})`);
  parts.push('```markdown');
  parts.push(snapshot.indexContent);
  parts.push('```');

  for (const file of snapshot.topicFiles) {
    parts.push(`\n### TOPIC FILE — ${file.relativePath}`);
    parts.push('```markdown');
    parts.push(file.content);
    parts.push('```');
  }
  return parts.join('\n');
}

/**
 * Apply a proposed snapshot back to the rootDir. Snapshots written to
 * `accepted/` first; existing files are backed up to `<root>/.dreams/backups/`
 * so manual recovery is trivial. Returns the list of files written.
 */
export function applyMemorySnapshot(
  rootDir: string,
  proposal: { indexContent: string; topicFiles: Array<{ relativePath: string; content: string }> },
  options: { backupDir?: string } = {},
): string[] {
  const backupDir = options.backupDir ?? join(rootDir, '.dreams', 'backups', timestampSlug());
  ensureDir(backupDir);

  const written: string[] = [];

  // Index
  const indexPath = join(rootDir, DEFAULT_INDEX_FILE);
  if (existsSync(indexPath)) {
    copyFileSync(indexPath, join(backupDir, DEFAULT_INDEX_FILE));
  }
  writeFileSync(indexPath, proposal.indexContent, 'utf-8');
  written.push(indexPath);

  // Topic files
  for (const file of proposal.topicFiles) {
    const target = join(rootDir, file.relativePath);
    ensureDir(dirOf(target));
    if (existsSync(target)) {
      copyFileSync(target, join(backupDir, basename(target)));
    }
    writeFileSync(target, file.content, 'utf-8');
    written.push(target);
  }

  return written;
}

// ── Internal helpers ────────────────────────────────────────────────────

function safeReadCapped(path: string, max: number): string {
  try {
    const raw = readFileSync(path, 'utf-8');
    if (raw.length <= max) return raw;
    return (
      raw.slice(0, max) + `\n\n…[TRUNCATED for prompt — original is ${raw.length} chars]`
    );
  } catch {
    return '';
  }
}

function matchesPrefix(filename: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  const lower = filename.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p.toLowerCase()));
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function dirOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash >= 0 ? path.slice(0, slash) : '.';
}

function timestampSlug(): string {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, '-');
}
