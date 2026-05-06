// Types for the Dreaming subsystem.
//
// "Dreaming" = offline memory consolidation. A dreamer reads recent session
// transcripts and the current memory tier (markdown files), then asks an LLM
// to produce a consolidated memory + a structured list of cross-session
// patterns. The patterns feed Kultiv's mutation engine as focus areas; the
// consolidated memory replaces the active memory tier after review.

export type DreamStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
}

export interface SessionTranscript {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  cwd?: string;
  gitBranch?: string;
  /** Compacted transcript text — bounded length, ready to feed to an LLM. */
  text: string;
  /** Total characters in the original raw transcript before compaction. */
  rawCharCount: number;
}

/**
 * One structured pattern surfaced by a dream. Persisted to
 * `.kultiv/dreams/patterns.md` and consumed by the mutation engine.
 */
export interface DreamPattern {
  id: string;
  /** Short headline — single sentence, imperative or descriptive. */
  title: string;
  /** Where this pattern was observed (session ids, file paths, agent names). */
  evidence: string[];
  /** Which artifact(s) the mutation engine should target. Empty = generic. */
  targetArtifacts: string[];
  severity: 'low' | 'medium' | 'high';
  /** "rule" | "preference" | "incident" | "fact" — used for grouping. */
  category: 'rule' | 'preference' | 'incident' | 'fact';
  body: string;
}

/**
 * Snapshot of the existing memory tier the dreamer is consolidating.
 */
export interface MemorySnapshot {
  rootDir: string;
  indexPath: string;
  indexContent: string;
  topicFiles: Array<{ path: string; relativePath: string; content: string }>;
  totalChars: number;
}

/**
 * Result of one dream run.
 */
export interface DreamResult {
  id: string;
  status: DreamStatus;
  startedAt: string;
  completedAt: string | null;
  model: string;
  inputSessionIds: string[];
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  proposedMemoryPath: string | null;
  proposedPatternsPath: string | null;
  summaryPath: string | null;
  patterns: DreamPattern[];
  error?: string;
}

export interface DreamHistoryEntry {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: DreamStatus;
  model: string;
  sessionCount: number;
  patternCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  applied: boolean;
  appliedAt: string | null;
  error?: string;
}
