import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readMemory,
  renderSnapshotForPrompt,
  applyMemorySnapshot,
} from '../../../src/dreaming/memory-store.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kultiv-mem-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('readMemory', () => {
  it('returns null when rootDir does not exist', () => {
    expect(readMemory(join(workDir, 'nope'))).toBeNull();
  });

  it('returns null when index file is missing', () => {
    writeFileSync(join(workDir, 'feedback_x.md'), 'x', 'utf-8');
    expect(readMemory(workDir)).toBeNull();
  });

  it('reads the index plus prefix-matching topic files in alpha order', () => {
    writeFileSync(join(workDir, 'MEMORY.md'), '# Index', 'utf-8');
    writeFileSync(join(workDir, 'feedback_b.md'), 'b', 'utf-8');
    writeFileSync(join(workDir, 'feedback_a.md'), 'a', 'utf-8');
    writeFileSync(join(workDir, 'project_x.md'), 'x', 'utf-8');
    writeFileSync(join(workDir, 'random.md'), 'should be ignored', 'utf-8');
    writeFileSync(join(workDir, 'LONG_TERM.md'), 'lt', 'utf-8');

    const snap = readMemory(workDir);
    expect(snap).not.toBeNull();
    expect(snap!.indexContent).toBe('# Index');
    // localeCompare uses case-insensitive collation, so uppercase 'LONG_TERM'
    // sorts alongside lowercase entries (between 'feedback_*' and 'project_*').
    expect(snap!.topicFiles.map((f) => f.relativePath)).toEqual([
      'feedback_a.md',
      'feedback_b.md',
      'LONG_TERM.md',
      'project_x.md',
    ]);
  });

  it('skips subdirectories', () => {
    writeFileSync(join(workDir, 'MEMORY.md'), '# Index', 'utf-8');
    mkdirSync(join(workDir, 'sub'));
    writeFileSync(join(workDir, 'sub', 'feedback_inside.md'), 'inside', 'utf-8');
    writeFileSync(join(workDir, 'feedback_top.md'), 'top', 'utf-8');

    const snap = readMemory(workDir);
    expect(snap!.topicFiles.map((f) => f.relativePath)).toEqual(['feedback_top.md']);
  });

  it('truncates files longer than maxCharsPerFile', () => {
    writeFileSync(join(workDir, 'MEMORY.md'), 'x'.repeat(50_000), 'utf-8');
    const snap = readMemory(workDir, { maxCharsPerFile: 5_000 });
    expect(snap!.indexContent).toContain('TRUNCATED');
    expect(snap!.indexContent.length).toBeLessThanOrEqual(5_500);
  });
});

describe('renderSnapshotForPrompt', () => {
  it('emits headed markdown blocks for index + topic files', () => {
    writeFileSync(join(workDir, 'MEMORY.md'), '# index', 'utf-8');
    writeFileSync(join(workDir, 'feedback_a.md'), '# feedback a', 'utf-8');
    const snap = readMemory(workDir)!;
    const text = renderSnapshotForPrompt(snap);
    expect(text).toContain('### MEMORY INDEX');
    expect(text).toContain('# index');
    expect(text).toContain('### TOPIC FILE — feedback_a.md');
    expect(text).toContain('# feedback a');
  });
});

describe('applyMemorySnapshot', () => {
  it('writes the new index + topic files and backs up originals', () => {
    writeFileSync(join(workDir, 'MEMORY.md'), '# OLD', 'utf-8');
    writeFileSync(join(workDir, 'feedback_a.md'), 'OLD body', 'utf-8');

    const written = applyMemorySnapshot(workDir, {
      indexContent: '# NEW',
      topicFiles: [
        { relativePath: 'feedback_a.md', content: 'NEW body' },
        { relativePath: 'feedback_new.md', content: 'brand new' },
      ],
    });

    expect(written.length).toBe(3);
    expect(readFileSync(join(workDir, 'MEMORY.md'), 'utf-8')).toBe('# NEW');
    expect(readFileSync(join(workDir, 'feedback_a.md'), 'utf-8')).toBe('NEW body');
    expect(readFileSync(join(workDir, 'feedback_new.md'), 'utf-8')).toBe('brand new');

    // Backups exist
    const backupRoot = join(workDir, '.dreams', 'backups');
    expect(existsSync(backupRoot)).toBe(true);
  });
});
