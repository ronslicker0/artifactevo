import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSessions, parseTranscriptFile } from '../../../src/dreaming/transcripts.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kultiv-dream-tx-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeSession(name: string, lines: object[]): string {
  const path = join(workDir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return path;
}

function userMsg(text: string, sessionId = 'sess-1', timestamp = '2026-05-01T00:00:00Z'): object {
  return {
    type: 'user',
    sessionId,
    timestamp,
    cwd: 'C:\\proj',
    gitBranch: 'main',
    message: { role: 'user', content: text },
  };
}

function assistantMsg(text: string, sessionId = 'sess-1', timestamp = '2026-05-01T00:00:01Z'): object {
  return {
    type: 'assistant',
    sessionId,
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

describe('parseTranscriptFile', () => {
  it('returns null for missing files', () => {
    expect(parseTranscriptFile(join(workDir, 'nope.jsonl'))).toBeNull();
  });

  it('parses a basic session into a compacted transcript', () => {
    const longContent = 'a'.repeat(600); // exceed MIN_USEFUL_CHARS
    const path = writeSession('a.jsonl', [
      userMsg(longContent),
      assistantMsg('Sure, here is the answer.'),
    ]);
    const tx = parseTranscriptFile(path);
    expect(tx).not.toBeNull();
    expect(tx!.sessionId).toBe('sess-1');
    expect(tx!.cwd).toBe('C:\\proj');
    expect(tx!.gitBranch).toBe('main');
    expect(tx!.messageCount).toBe(2);
    expect(tx!.text).toContain('USER');
    expect(tx!.text).toContain('ASSISTANT');
    expect(tx!.text).toContain('Sure, here is the answer.');
  });

  it('skips queue-operation and malformed lines', () => {
    const path = join(workDir, 'b.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: 't0' }),
        '{not json',
        JSON.stringify(userMsg('real message has enough characters '.repeat(20))),
      ].join('\n'),
      'utf-8',
    );
    const tx = parseTranscriptFile(path);
    expect(tx).not.toBeNull();
    expect(tx!.messageCount).toBe(1);
  });

  it('extracts text from structured assistant content blocks', () => {
    const path = writeSession('c.jsonl', [
      userMsg('hello world '.repeat(60)),
      {
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: 't1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'response text here' },
            { type: 'tool_use', name: 'Read', input: {} },
          ],
        },
      },
    ]);
    const tx = parseTranscriptFile(path);
    expect(tx!.text).toContain('response text here');
    expect(tx!.text).toContain('[tool_use:Read]');
  });

  it('caps total compacted text near maxChars', () => {
    const huge = 'x'.repeat(50_000);
    const path = writeSession('d.jsonl', [userMsg(huge), assistantMsg(huge), assistantMsg(huge)]);
    const tx = parseTranscriptFile(path, 5_000);
    expect(tx!.text.length).toBeLessThanOrEqual(20_000); // each msg truncated to 4k + slack
  });
});

describe('readSessions', () => {
  it('returns empty when sessionsDir does not exist', () => {
    expect(readSessions(join(workDir, 'missing'))).toEqual([]);
  });

  it('returns transcripts sorted by mtime descending and respects limit', () => {
    const longText = 'content '.repeat(200); // 1600 chars
    const a = writeSession('a.jsonl', [userMsg(longText, 'a')]);
    const b = writeSession('b.jsonl', [userMsg(longText, 'b')]);
    const c = writeSession('c.jsonl', [userMsg(longText, 'c')]);
    // a oldest, c newest
    const now = Date.now() / 1000;
    utimesSync(a, now - 100, now - 100);
    utimesSync(b, now - 50, now - 50);
    utimesSync(c, now - 1, now - 1);

    const out = readSessions(workDir, { limit: 2 });
    expect(out.map((s) => s.sessionId)).toEqual(['c', 'b']);
  });

  it('drops empty / tiny sessions below MIN_USEFUL_CHARS', () => {
    writeSession('tiny.jsonl', [userMsg('hi')]);
    writeSession('big.jsonl', [userMsg('content '.repeat(200))]);
    const out = readSessions(workDir);
    expect(out.length).toBe(1);
    expect(out[0].sessionId).toBe('sess-1');
  });

  it('respects withinDays cutoff', () => {
    const oldFile = writeSession('old.jsonl', [userMsg('content '.repeat(200), 'old')]);
    const oldMtime = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldFile, oldMtime, oldMtime);
    writeSession('new.jsonl', [userMsg('content '.repeat(200), 'new')]);

    const out = readSessions(workDir, { withinDays: 7 });
    expect(out.map((s) => s.sessionId)).toEqual(['new']);
  });

  it('skips sub-directories (Claude Code stores nested dirs alongside jsonl)', () => {
    mkdirSync(join(workDir, 'subdir'));
    writeSession('a.jsonl', [userMsg('content '.repeat(200))]);
    const out = readSessions(workDir);
    expect(out.length).toBe(1);
  });
});
