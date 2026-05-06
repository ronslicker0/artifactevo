import { describe, it, expect } from 'vitest';
import { buildDreamPrompt, parseDreamResponse } from '../../../src/dreaming/prompts.js';
import type { MemorySnapshot, SessionTranscript } from '../../../src/dreaming/types.js';

const snapshot: MemorySnapshot = {
  rootDir: '/mem',
  indexPath: '/mem/MEMORY.md',
  indexContent: '# Index\n- [x](feedback_x.md) hook',
  topicFiles: [
    { path: '/mem/feedback_x.md', relativePath: 'feedback_x.md', content: '---\nname: x\n---\nbody' },
  ],
  totalChars: 50,
};

const tx: SessionTranscript = {
  sessionId: 'sess-1',
  startedAt: '2026-05-01T00:00:00Z',
  endedAt: '2026-05-01T00:01:00Z',
  messageCount: 4,
  cwd: 'C:\\proj',
  gitBranch: 'main',
  text: '### USER\nhi\n\n### ASSISTANT\nhello',
  rawCharCount: 100,
};

describe('buildDreamPrompt', () => {
  it('includes the snapshot, sessions, and the strict output format', () => {
    const prompt = buildDreamPrompt({
      snapshot,
      sessions: [tx],
      previousPatterns: [],
      recentWins: [],
    });
    expect(prompt).toContain('## Task: DREAM');
    expect(prompt).toContain('### MEMORY INDEX');
    expect(prompt).toContain('### SESSION 1');
    expect(prompt).toContain('===PATTERNS_JSON===');
    expect(prompt).toContain('===NEW_INDEX===');
    expect(prompt).toContain('TOPIC_FILE');
  });

  it('includes user instructions when provided', () => {
    const prompt = buildDreamPrompt({
      snapshot,
      sessions: [tx],
      instructions: 'Focus on auth-related patterns.',
    });
    expect(prompt).toContain('## User Instructions for This Dream');
    expect(prompt).toContain('Focus on auth-related patterns.');
  });

  it('renders previous-patterns block when provided', () => {
    const prompt = buildDreamPrompt({
      snapshot,
      sessions: [tx],
      previousPatterns: [
        {
          id: 'PT-OLD',
          title: 'old one',
          severity: 'high',
          category: 'rule',
          targetArtifacts: ['x'],
          evidence: [],
          body: '',
        },
      ],
    });
    expect(prompt).toContain('PT-OLD: old one');
  });
});

describe('parseDreamResponse', () => {
  it('parses a well-formed response', () => {
    const response = `Here we go.

===PATTERNS_JSON===
{
  "patterns": [
    {
      "id": "PT001",
      "title": "Repeated mistake",
      "severity": "high",
      "category": "rule",
      "targetArtifacts": ["agent-foo"],
      "evidence": ["sess-1"],
      "body": "Across 3 sessions the agent forgot X."
    }
  ],
  "summary": "Merged 2 dupes; 1 high pattern."
}
===END_PATTERNS_JSON===

===NEW_INDEX===
# Index v2
- [x](feedback_x.md) updated hook
===END_NEW_INDEX===

===TOPIC_FILE: feedback_x.md===
---
name: x
description: updated
type: feedback
---
new body
===END_TOPIC_FILE===
`;

    const parsed = parseDreamResponse(response);
    expect(parsed.errors).toEqual([]);
    expect(parsed.patterns.length).toBe(1);
    expect(parsed.patterns[0].id).toBe('PT001');
    expect(parsed.patterns[0].targetArtifacts).toEqual(['agent-foo']);
    expect(parsed.summary).toContain('Merged 2 dupes');
    expect(parsed.newIndex).toContain('# Index v2');
    expect(parsed.topicFiles).toHaveLength(1);
    expect(parsed.topicFiles[0].relativePath).toBe('feedback_x.md');
    expect(parsed.topicFiles[0].content).toContain('updated');
    expect(parsed.topicFiles[0].content).toContain('new body');
  });

  it('strips markdown fences around the JSON block', () => {
    const response = `===PATTERNS_JSON===
\`\`\`json
{ "patterns": [], "summary": "nothing" }
\`\`\`
===END_PATTERNS_JSON===

===NEW_INDEX===
ok
===END_NEW_INDEX===
`;
    const parsed = parseDreamResponse(response);
    expect(parsed.errors).toEqual([]);
    expect(parsed.patterns).toEqual([]);
    expect(parsed.summary).toBe('nothing');
  });

  it('reports missing sections', () => {
    const parsed = parseDreamResponse('garbage');
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors.some((e) => e.includes('PATTERNS_JSON'))).toBe(true);
    expect(parsed.errors.some((e) => e.includes('NEW_INDEX'))).toBe(true);
  });

  it('coerces invalid pattern fields to safe defaults', () => {
    const response = `===PATTERNS_JSON===
{
  "patterns": [
    { "id": "P1", "title": "ok", "severity": "ULTRA", "category": "alien" }
  ],
  "summary": "x"
}
===END_PATTERNS_JSON===

===NEW_INDEX===
ok
===END_NEW_INDEX===
`;
    const parsed = parseDreamResponse(response);
    expect(parsed.patterns[0].severity).toBe('medium');
    expect(parsed.patterns[0].category).toBe('rule');
    expect(parsed.patterns[0].targetArtifacts).toEqual([]);
    expect(parsed.patterns[0].evidence).toEqual([]);
  });
});
