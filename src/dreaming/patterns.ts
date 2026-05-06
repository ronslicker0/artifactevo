import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DreamPattern } from './types.js';

// Format used for `.kultiv/dreams/patterns.md`. Designed to be both
// human-readable and reliably round-trippable by the mutation engine.
//
// Example record:
//
// ## Pattern: PT001 — Auth checks frequently missing on new API routes
// - Severity: high
// - Category: rule
// - Targets: beepbop-api, beepbop-database
// - Evidence: session-abc123, session-def456
//
// API routes added in 3+ sessions shipped without `supabase.auth.getUser()`
// checks. The reviewer caught these post-merge. Suggest: add explicit
// auth-check requirement + example to `beepbop-api` agent prompt.
//
// ---

const SEVERITIES = new Set<DreamPattern['severity']>(['low', 'medium', 'high']);
const CATEGORIES = new Set<DreamPattern['category']>(['rule', 'preference', 'incident', 'fact']);

// ── Public API ──────────────────────────────────────────────────────────

export interface RenderPatternsOptions {
  generatedAt?: string;
  sessionCount?: number;
  modelId?: string;
}

/**
 * Render a list of patterns to the markdown format consumed by the mutation
 * engine. Always emits a stable header so diffs are predictable.
 */
export function renderPatternsMarkdown(
  patterns: DreamPattern[],
  options: RenderPatternsOptions = {},
): string {
  const ts = options.generatedAt ?? new Date().toISOString();
  const sc = options.sessionCount ?? 0;
  const model = options.modelId ?? 'unknown';

  const lines: string[] = [
    '# Dream Patterns',
    '',
    `> Generated ${ts} from ${sc} session(s) with ${model}.`,
    '> Consumed by Kultiv\'s mutation engine as focus-area hints.',
    '',
  ];

  if (patterns.length === 0) {
    lines.push('_No patterns surfaced this run._');
    lines.push('');
    return lines.join('\n');
  }

  for (const p of patterns) {
    lines.push(`## Pattern: ${p.id} — ${oneLine(p.title)}`);
    lines.push(`- Severity: ${p.severity}`);
    lines.push(`- Category: ${p.category}`);
    lines.push(`- Targets: ${p.targetArtifacts.length > 0 ? p.targetArtifacts.join(', ') : '(none)'}`);
    lines.push(`- Evidence: ${p.evidence.length > 0 ? p.evidence.join(', ') : '(none)'}`);
    lines.push('');
    lines.push(p.body.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Inverse of renderPatternsMarkdown — parse patterns out of an existing file.
 * Tolerates extra prose in the body; missing files return an empty array.
 */
export function parsePatternsMarkdown(markdown: string): DreamPattern[] {
  const out: DreamPattern[] = [];
  const sections = markdown.split(/^##\s+Pattern:\s+/m).slice(1);

  for (const section of sections) {
    const headerLine = section.split('\n', 1)[0];
    const dashIdx = headerLine.indexOf('—');
    const altDashIdx = dashIdx === -1 ? headerLine.indexOf('-') : -1;
    const splitAt = dashIdx >= 0 ? dashIdx : altDashIdx;
    if (splitAt < 0) continue;

    const id = headerLine.slice(0, splitAt).trim();
    const title = headerLine.slice(splitAt + 1).trim();

    const meta = extractMeta(section);
    const body = extractBody(section);
    if (!id || !title) continue;

    out.push({
      id,
      title,
      severity: coerceSeverity(meta.severity),
      category: coerceCategory(meta.category),
      targetArtifacts: splitList(meta.targets),
      evidence: splitList(meta.evidence),
      body,
    });
  }

  return out;
}

/**
 * Read the patterns file (if any). Returns an empty list if missing/unreadable
 * — the mutation engine can run without dream input.
 */
export function readPatternsFile(path: string): DreamPattern[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    return parsePatternsMarkdown(raw);
  } catch {
    return [];
  }
}

/**
 * Write patterns to disk, creating parent directories as needed.
 */
export function writePatternsFile(
  path: string,
  patterns: DreamPattern[],
  options: RenderPatternsOptions = {},
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderPatternsMarkdown(patterns, options), 'utf-8');
}

/**
 * Build a short "focus areas" block to inject into a mutation prompt for a
 * given target artifact. Returns empty string when no patterns apply, so the
 * caller can append unconditionally.
 */
export function buildFocusAreasBlock(
  patterns: DreamPattern[],
  artifactId: string,
  maxItems = 5,
): string {
  if (patterns.length === 0) return '';

  // Patterns explicitly targeting this artifact rank first; generic patterns
  // (no targets) come second; off-target patterns are dropped entirely.
  const onTarget = patterns.filter((p) => p.targetArtifacts.includes(artifactId));
  const generic = patterns.filter((p) => p.targetArtifacts.length === 0);
  const ordered = [...sortBySeverity(onTarget), ...sortBySeverity(generic)].slice(0, maxItems);
  if (ordered.length === 0) return '';

  const items = ordered.map(
    (p) =>
      `- [${p.severity}/${p.category}] **${p.title}** — ${oneLine(firstSentence(p.body))} (evidence: ${
        p.evidence.length > 0 ? p.evidence.slice(0, 3).join(', ') : 'n/a'
      })`,
  );

  return [
    '## Dream-Surfaced Focus Areas',
    'Cross-session patterns the dreamer has surfaced. PRIORITIZE addressing these in your mutation candidates:',
    ...items,
    '',
  ].join('\n');
}

// ── Internals ───────────────────────────────────────────────────────────

function extractMeta(section: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*-\s+([A-Za-z]+):\s*(.+?)\s*$/);
    if (!m) continue;
    meta[m[1].toLowerCase()] = m[2];
  }
  return meta;
}

function extractBody(section: string): string {
  const lines = section.split('\n');
  // Skip header line + meta lines (those starting with "- Foo:") + the blank
  // line directly after meta. Body ends at the next "---" or end of section.
  let i = 1;
  while (i < lines.length && lines[i].match(/^\s*-\s+[A-Za-z]+:/)) i++;
  while (i < lines.length && lines[i].trim() === '') i++;

  const bodyLines: string[] = [];
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    bodyLines.push(lines[i]);
  }
  return bodyLines.join('\n').trim();
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  if (/^\(?\s*none\s*\)?$/i.test(value.trim())) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^\(?\s*none\s*\)?$/i.test(s));
}

function coerceSeverity(value: string | undefined): DreamPattern['severity'] {
  if (value && SEVERITIES.has(value as DreamPattern['severity'])) {
    return value as DreamPattern['severity'];
  }
  return 'medium';
}

function coerceCategory(value: string | undefined): DreamPattern['category'] {
  if (value && CATEGORIES.has(value as DreamPattern['category'])) {
    return value as DreamPattern['category'];
  }
  return 'rule';
}

function sortBySeverity(patterns: DreamPattern[]): DreamPattern[] {
  const rank: Record<DreamPattern['severity'], number> = { high: 0, medium: 1, low: 2 };
  return [...patterns].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function firstSentence(body: string): string {
  const trimmed = body.trim();
  const m = trimmed.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : trimmed.slice(0, 200);
}
