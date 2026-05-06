import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionMessage, SessionTranscript } from './types.js';

// ── Constants ───────────────────────────────────────────────────────────

/** Hard cap on how many characters of any single transcript we feed to the LLM. */
const DEFAULT_MAX_CHARS_PER_SESSION = 30_000;

/** Skip transcripts smaller than this — they're usually empty / single-message. */
const MIN_USEFUL_CHARS = 500;

// ── Public API ──────────────────────────────────────────────────────────

export interface ReadSessionsOptions {
  /** Max number of transcripts to return (most recent first). */
  limit?: number;
  /** Only include sessions modified within this many days. Default: 14. */
  withinDays?: number;
  /** Per-transcript char cap before LLM feeding. Default: 30,000. */
  maxCharsPerSession?: number;
}

/**
 * Discover and parse Claude Code session JSONL files in `sessionsDir`.
 *
 * Returns transcripts sorted by mtime descending (most recent first), with
 * each transcript compacted into a bounded text block ready for LLM input.
 * Sessions below MIN_USEFUL_CHARS are dropped.
 */
export function readSessions(
  sessionsDir: string,
  options: ReadSessionsOptions = {},
): SessionTranscript[] {
  if (!existsSync(sessionsDir)) return [];

  const limit = options.limit ?? 20;
  const withinDays = options.withinDays ?? 14;
  const maxChars = options.maxCharsPerSession ?? DEFAULT_MAX_CHARS_PER_SESSION;
  const cutoffMs = Date.now() - withinDays * 24 * 60 * 60 * 1000;

  // Find candidate .jsonl files (top-level, not in subdirs).
  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const full = join(sessionsDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoffMs) continue;
    candidates.push({ path: full, mtime: st.mtimeMs });
  }

  candidates.sort((a, b) => b.mtime - a.mtime);

  const out: SessionTranscript[] = [];
  for (const { path } of candidates) {
    const transcript = parseTranscriptFile(path, maxChars);
    if (!transcript) continue;
    if (transcript.rawCharCount < MIN_USEFUL_CHARS) continue;
    out.push(transcript);
    if (out.length >= limit) break;
  }

  return out;
}

/**
 * Parse a single JSONL session file into a compacted SessionTranscript.
 * Returns null on unreadable file. Malformed lines are skipped.
 */
export function parseTranscriptFile(
  path: string,
  maxChars: number = DEFAULT_MAX_CHARS_PER_SESSION,
): SessionTranscript | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  const messages: SessionMessage[] = [];
  let sessionId = '';
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let firstTimestamp = '';
  let lastTimestamp = '';
  let rawCharCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.sessionId === 'string' && !sessionId) sessionId = parsed.sessionId;
    if (typeof parsed.cwd === 'string' && !cwd) cwd = parsed.cwd;
    if (typeof parsed.gitBranch === 'string' && !gitBranch) gitBranch = parsed.gitBranch;
    if (typeof parsed.timestamp === 'string') {
      if (!firstTimestamp) firstTimestamp = parsed.timestamp;
      lastTimestamp = parsed.timestamp;
    }

    const msg = extractMessage(parsed);
    if (!msg) continue;
    messages.push(msg);
    rawCharCount += msg.content.length;
  }

  if (messages.length === 0) {
    return null;
  }

  const text = compactMessages(messages, maxChars);

  return {
    sessionId: sessionId || basenameWithoutExt(path),
    startedAt: firstTimestamp || new Date(0).toISOString(),
    endedAt: lastTimestamp || firstTimestamp || new Date(0).toISOString(),
    messageCount: messages.length,
    cwd,
    gitBranch,
    text,
    rawCharCount,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

interface ClaudeMessageEnvelope {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  timestamp?: string;
}

function extractMessage(parsed: Record<string, unknown>): SessionMessage | null {
  const env = parsed as ClaudeMessageEnvelope;

  // Skip queue-operation/meta entries.
  if (env.type === 'queue-operation') return null;

  const role = env.message?.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
    return null;
  }

  const content = stringifyContent(env.message?.content);
  if (!content) return null;

  return {
    role,
    content,
    timestamp: env.timestamp,
  };
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      parts.push(`[tool_use:${b.name}]`);
    } else if (b.type === 'tool_result') {
      const inner = stringifyContent(b.content);
      if (inner) parts.push(`[tool_result]\n${truncate(inner, 1200)}`);
    }
  }
  return parts.join('\n');
}

/**
 * Compact a sequence of messages into a single text block bounded by maxChars.
 * Strategy: keep the FIRST user message verbatim (it's the original goal),
 * then keep the most recent messages until we hit the budget.
 */
function compactMessages(messages: SessionMessage[], maxChars: number): string {
  if (messages.length === 0) return '';

  const formatted = messages.map((m) => {
    const tag = m.role.toUpperCase();
    const content = truncate(m.content.trim(), 4000);
    return `### ${tag}\n${content}`;
  });

  // Always include first message + last messages until budget exceeded.
  const head = formatted[0];
  const tail: string[] = [];
  let used = head.length + 200; // padding for separators

  for (let i = formatted.length - 1; i > 0; i--) {
    const piece = formatted[i];
    if (used + piece.length > maxChars) break;
    tail.unshift(piece);
    used += piece.length + 2;
  }

  if (tail.length === 0) return head.slice(0, maxChars);

  const omittedCount = formatted.length - 1 - tail.length;
  const omittedNote = omittedCount > 0 ? `\n\n…[${omittedCount} earlier messages omitted]…\n\n` : '\n\n';
  return head + omittedNote + tail.join('\n\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[truncated ${s.length - max} chars]`;
}

function basenameWithoutExt(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
