import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderPatternsMarkdown,
  parsePatternsMarkdown,
  readPatternsFile,
  writePatternsFile,
  buildFocusAreasBlock,
} from '../../../src/dreaming/patterns.js';
import type { DreamPattern } from '../../../src/dreaming/types.js';

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kultiv-pat-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const sample: DreamPattern = {
  id: 'PT001',
  title: 'Auth checks missing on new API routes',
  severity: 'high',
  category: 'rule',
  targetArtifacts: ['beepbop-api'],
  evidence: ['sess-abc', 'sess-def'],
  body: 'API routes added in 3+ sessions shipped without auth checks. Suggest adding an explicit rule + example.',
};

describe('renderPatternsMarkdown', () => {
  it('renders a header and one record per pattern', () => {
    const md = renderPatternsMarkdown([sample], { sessionCount: 7, modelId: 'sonnet-4-6' });
    expect(md).toContain('# Dream Patterns');
    expect(md).toContain('from 7 session(s) with sonnet-4-6');
    expect(md).toContain('## Pattern: PT001 — Auth checks missing on new API routes');
    expect(md).toContain('- Severity: high');
    expect(md).toContain('- Category: rule');
    expect(md).toContain('- Targets: beepbop-api');
    expect(md).toContain('- Evidence: sess-abc, sess-def');
    expect(md).toContain('explicit rule + example');
    expect(md).toContain('---');
  });

  it('renders an empty placeholder when no patterns', () => {
    const md = renderPatternsMarkdown([]);
    expect(md).toContain('_No patterns surfaced this run._');
  });
});

describe('parsePatternsMarkdown', () => {
  it('round-trips a rendered file', () => {
    const md = renderPatternsMarkdown([sample, { ...sample, id: 'PT002', title: 'Other' }]);
    const parsed = parsePatternsMarkdown(md);
    expect(parsed.length).toBe(2);
    expect(parsed[0].id).toBe('PT001');
    expect(parsed[0].title).toBe('Auth checks missing on new API routes');
    expect(parsed[0].severity).toBe('high');
    expect(parsed[0].category).toBe('rule');
    expect(parsed[0].targetArtifacts).toEqual(['beepbop-api']);
    expect(parsed[0].evidence).toEqual(['sess-abc', 'sess-def']);
    expect(parsed[0].body).toContain('API routes added');
  });

  it('coerces invalid severity/category to defaults', () => {
    const md = `## Pattern: PT9 — Garbled
- Severity: ULTRA
- Category: alien
- Targets: (none)
- Evidence: (none)

body here
`;
    const parsed = parsePatternsMarkdown(md);
    expect(parsed[0].severity).toBe('medium');
    expect(parsed[0].category).toBe('rule');
    expect(parsed[0].targetArtifacts).toEqual([]);
    expect(parsed[0].evidence).toEqual([]);
  });

  it('returns empty list when no patterns in input', () => {
    expect(parsePatternsMarkdown('# Dream Patterns\n\nnothing here')).toEqual([]);
  });
});

describe('read/writePatternsFile', () => {
  it('returns empty list when file is missing', () => {
    expect(readPatternsFile(join(workDir, 'missing.md'))).toEqual([]);
  });

  it('round-trips through write+read', () => {
    const path = join(workDir, 'sub', 'patterns.md');
    writePatternsFile(path, [sample]);
    const read = readPatternsFile(path);
    expect(read.length).toBe(1);
    expect(read[0].title).toBe(sample.title);
  });
});

describe('buildFocusAreasBlock', () => {
  it('returns empty string when no patterns', () => {
    expect(buildFocusAreasBlock([], 'beepbop-api')).toBe('');
  });

  it('prioritizes on-target patterns over generic ones', () => {
    const onTarget: DreamPattern = { ...sample, id: 'PT-TARGET', title: 'on-target hit' };
    const generic: DreamPattern = {
      ...sample,
      id: 'PT-GENERIC',
      title: 'generic finding',
      targetArtifacts: [],
    };
    const block = buildFocusAreasBlock([generic, onTarget], 'beepbop-api');
    expect(block).toContain('Dream-Surfaced Focus Areas');
    const onTargetIdx = block.indexOf('on-target hit');
    const genericIdx = block.indexOf('generic finding');
    expect(onTargetIdx).toBeGreaterThan(-1);
    expect(genericIdx).toBeGreaterThan(-1);
    expect(onTargetIdx).toBeLessThan(genericIdx);
  });

  it('drops off-target patterns with non-empty other targets', () => {
    const offTarget: DreamPattern = { ...sample, id: 'PT-OFF', targetArtifacts: ['nina'] };
    const block = buildFocusAreasBlock([offTarget], 'beepbop-api');
    expect(block).toBe('');
  });

  it('respects maxItems limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...sample,
      id: `PT${i}`,
      title: `t${i}`,
      severity: 'medium' as const,
    }));
    const block = buildFocusAreasBlock(many, 'beepbop-api', 3);
    const itemCount = (block.match(/^- \[/gm) ?? []).length;
    expect(itemCount).toBe(3);
  });
});
