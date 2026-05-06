import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDream, applyDream, rejectDream } from '../../../src/dreaming/dreamer.js';
import type { LLMProvider, LLMMessage, LLMResponse, LLMGenerateOptions } from '../../../src/llm/provider.js';

class MockProvider implements LLMProvider {
  public callCount = 0;
  public lastPrompt = '';
  constructor(private response: string) {}
  async generate(messages: LLMMessage[], _options?: LLMGenerateOptions): Promise<LLMResponse> {
    this.callCount += 1;
    this.lastPrompt = messages.map((m) => m.content).join('\n');
    return {
      content: this.response,
      input_tokens: 1234,
      output_tokens: 567,
    };
  }
}

const VALID_RESPONSE = `===PATTERNS_JSON===
{
  "patterns": [
    {
      "id": "PT001",
      "title": "Repeated auth omission",
      "severity": "high",
      "category": "rule",
      "targetArtifacts": ["agent-foo"],
      "evidence": ["sess-1"],
      "body": "Across 3+ sessions, auth checks were missing on new API routes."
    }
  ],
  "summary": "Surfaced 1 high-severity pattern; no merges needed."
}
===END_PATTERNS_JSON===

===NEW_INDEX===
# BeepBop Studio — Memory Index v2

- New consolidated entry.
===END_NEW_INDEX===

===TOPIC_FILE: feedback_auth.md===
---
name: Auth checks
description: Always require auth on new API routes
type: feedback
---

Updated body.
===END_TOPIC_FILE===
`;

let workDir: string;
let evoDir: string;
let memoryDir: string;
let sessionsDir: string;
let archivePath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'kultiv-dreamer-'));
  evoDir = join(workDir, 'evo');
  memoryDir = join(workDir, 'memory');
  sessionsDir = join(workDir, 'sessions');
  archivePath = join(evoDir, 'archive.jsonl');
  mkdirSync(evoDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  // Seed memory tier
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Index\n- (placeholder)', 'utf-8');
  writeFileSync(
    join(memoryDir, 'feedback_auth.md'),
    '---\nname: Auth\ndescription: x\ntype: feedback\n---\nold body',
    'utf-8',
  );

  // Seed a fake session
  const longContent = 'meaningful session content '.repeat(60);
  writeFileSync(
    join(sessionsDir, 'sess-1.jsonl'),
    JSON.stringify({
      type: 'user',
      sessionId: 'sess-1',
      timestamp: '2026-05-01T00:00:00Z',
      cwd: 'C:\\proj',
      gitBranch: 'main',
      message: { role: 'user', content: longContent },
    }) + '\n',
    'utf-8',
  );

  // Seed a Kultiv archive with one win
  writeFileSync(
    archivePath,
    JSON.stringify({
      genid: 1,
      artifact: 'agent-foo',
      parent: null,
      score: 92,
      max_score: 100,
      challenge: null,
      run_id: 'r1',
      diff: null,
      mutation_type: 'ADD_RULE',
      mutation_desc: 'add rule',
      status: 'success',
      timestamp: '2026-05-01T00:00:00Z',
      token_cost: 100,
      automated: true,
    }) + '\n',
    'utf-8',
  );
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const baseOpts = () => ({
  evoDir,
  memoryDir,
  sessionsDir,
  archivePath,
  modelId: 'claude-sonnet-4-6',
  inputCostPerMTok: 3,
  outputCostPerMTok: 15,
});

describe('runDream', () => {
  it('completes a happy-path dream and writes proposal artifacts', async () => {
    const provider = new MockProvider(VALID_RESPONSE);
    const out = await runDream({ ...baseOpts(), provider }, { force: true });

    expect(out.skipped).toBeUndefined();
    expect(out.applied).toBe(false);
    expect(out.result.status).toBe('completed');
    expect(out.result.patterns.length).toBe(1);
    expect(out.result.patterns[0].id).toBe('PT001');
    expect(provider.callCount).toBe(1);

    // Proposal files exist
    const proposalRoot = join(evoDir, 'dreams', 'proposed', out.result.id);
    expect(existsSync(join(proposalRoot, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(proposalRoot, 'patterns.md'))).toBe(true);
    expect(existsSync(join(proposalRoot, 'summary.md'))).toBe(true);
    expect(existsSync(join(proposalRoot, 'feedback_auth.md'))).toBe(true);
    expect(existsSync(join(proposalRoot, 'response.txt'))).toBe(true);

    // patterns.md (active) is updated for the mutation engine
    const activePatterns = readFileSync(join(evoDir, 'dreams', 'patterns.md'), 'utf-8');
    expect(activePatterns).toContain('PT001');

    // History is recorded
    const history = readFileSync(join(evoDir, 'dreams', 'history.jsonl'), 'utf-8');
    expect(history).toContain('"status":"completed"');

    // Cost computed
    expect(out.result.estimatedCostUsd).toBeGreaterThan(0);

    // Live memory not yet touched
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8')).not.toContain('Memory Index v2');
  });

  it('respects cooldown unless force is set', async () => {
    const provider = new MockProvider(VALID_RESPONSE);

    // First run with force succeeds.
    await runDream({ ...baseOpts(), provider }, { force: true });
    expect(provider.callCount).toBe(1);

    // Second run without force should be cooldown-skipped.
    const out = await runDream({ ...baseOpts(), provider }, { cooldownHours: 6 });
    expect(out.skipped).toBe('cooldown');
    expect(provider.callCount).toBe(1); // not invoked again
  });

  it('auto-applies and updates live memory when autoApply=true', async () => {
    const provider = new MockProvider(VALID_RESPONSE);
    const out = await runDream({ ...baseOpts(), provider }, { force: true, autoApply: true });
    expect(out.applied).toBe(true);
    expect(out.result.status).toBe('completed');
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8')).toContain('Memory Index v2');
    expect(readFileSync(join(memoryDir, 'feedback_auth.md'), 'utf-8')).toContain('Updated body');
    // Backups exist
    expect(existsSync(join(memoryDir, '.dreams', 'backups'))).toBe(true);
    // Proposal moved to accepted/
    expect(existsSync(join(evoDir, 'dreams', 'accepted', out.result.id))).toBe(true);
  });

  it('returns no-memory skip when memory dir is missing index', async () => {
    rmSync(join(memoryDir, 'MEMORY.md'));
    const provider = new MockProvider(VALID_RESPONSE);
    const out = await runDream({ ...baseOpts(), provider }, { force: true });
    expect(out.skipped).toBe('no-memory');
    expect(provider.callCount).toBe(0);
  });

  it('returns no-sessions skip when no recent sessions', async () => {
    for (const f of readdirSync(sessionsDir)) rmSync(join(sessionsDir, f));
    const provider = new MockProvider(VALID_RESPONSE);
    const out = await runDream({ ...baseOpts(), provider }, { force: true });
    expect(out.skipped).toBe('no-sessions');
    expect(provider.callCount).toBe(0);
  });

  it('records failure when LLM response is malformed', async () => {
    const provider = new MockProvider('totally garbage');
    const out = await runDream({ ...baseOpts(), provider }, { force: true });
    expect(out.result.status).toBe('failed');
    expect(out.result.error).toBeTruthy();
    // Active patterns.md NOT updated when no patterns parsed
    expect(existsSync(join(evoDir, 'dreams', 'patterns.md'))).toBe(false);
  });
});

describe('applyDream / rejectDream', () => {
  it('applyDream writes new memory and moves proposal to accepted/', async () => {
    const provider = new MockProvider(VALID_RESPONSE);
    const out = await runDream({ ...baseOpts(), provider }, { force: true });
    expect(out.result.status).toBe('completed');

    applyDream({ memoryDir, evoDir }, out.result);
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf-8')).toContain('Memory Index v2');
    expect(existsSync(join(evoDir, 'dreams', 'accepted', out.result.id))).toBe(true);
    expect(existsSync(join(evoDir, 'dreams', 'proposed', out.result.id))).toBe(false);
  });

  it('rejectDream moves proposal to rejected/', async () => {
    const provider = new MockProvider(VALID_RESPONSE);
    const out = await runDream({ ...baseOpts(), provider }, { force: true });
    expect(out.result.status).toBe('completed');

    rejectDream({ evoDir }, out.result);
    expect(existsSync(join(evoDir, 'dreams', 'rejected', out.result.id))).toBe(true);
    expect(existsSync(join(evoDir, 'dreams', 'proposed', out.result.id))).toBe(false);
  });
});
