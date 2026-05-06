// Smoke test: runs the full dreamer pipeline against the user's REAL Claude
// Code session JSONL files and REAL memory tier, with a mocked LLM provider.
// Confirms transcript discovery, memory loading, prompt construction, and
// proposal artifact writing all work on actual production-shaped data.
//
// Skipped automatically if the real paths aren't on this machine, so it never
// breaks CI for other contributors.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { runDream } from '../../../src/dreaming/dreamer.js';
import type {
  LLMProvider,
  LLMMessage,
  LLMResponse,
  LLMGenerateOptions,
} from '../../../src/llm/provider.js';

const PROJECT_KEY = 'C--Users-Eve-Desktop-Beepbop-Studio';
const MEMORY_DIR = join(homedir(), '.claude', 'projects', PROJECT_KEY, 'memory');
const SESSIONS_DIR = join(homedir(), '.claude', 'projects', PROJECT_KEY);

const REAL_DATA_AVAILABLE = existsSync(join(MEMORY_DIR, 'MEMORY.md'));

// Build a deterministic but plausible LLM response that references real
// session-id stems pulled from disk so the resulting proposal looks real.
function buildMockResponse(sessionsDir: string): string {
  const sampleId = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''))[0]?.slice(0, 12) ?? 'sess-unknown';

  return `===PATTERNS_JSON===
{
  "patterns": [
    {
      "id": "PT001",
      "title": "Smoke test pattern",
      "severity": "medium",
      "category": "rule",
      "targetArtifacts": [],
      "evidence": ["${sampleId}"],
      "body": "Synthetic pattern emitted by smoke test for end-to-end verification."
    }
  ],
  "summary": "Smoke test synthetic dream — no real consolidation performed."
}
===END_PATTERNS_JSON===

===NEW_INDEX===
# BeepBop Studio — Memory Index (smoke synthetic)

> Synthetic smoke test output — DO NOT APPLY.

- (placeholder)
===END_NEW_INDEX===
`;
}

class FixedProvider implements LLMProvider {
  constructor(private response: string) {}
  async generate(_messages: LLMMessage[], _opts?: LLMGenerateOptions): Promise<LLMResponse> {
    return { content: this.response, input_tokens: 8000, output_tokens: 1500 };
  }
}

describe('end-to-end smoke against real BeepBop data', () => {
  let tmpEvoDir: string;

  beforeAll(() => {
    if (!REAL_DATA_AVAILABLE) return;
    tmpEvoDir = mkdtempSync(join(tmpdir(), 'kultiv-smoke-'));
  });

  it.skipIf(!REAL_DATA_AVAILABLE)('runs end-to-end against real memory + sessions', async () => {
    const provider = new FixedProvider(buildMockResponse(SESSIONS_DIR));

    const out = await runDream(
      {
        evoDir: tmpEvoDir,
        memoryDir: MEMORY_DIR,
        sessionsDir: SESSIONS_DIR,
        archivePath: join(tmpEvoDir, 'archive.jsonl'),
        provider,
        modelId: 'claude-sonnet-4-6',
        maxSessions: 5,
        withinDays: 30,
      },
      { force: true },
    );

    expect(out.skipped).toBeUndefined();
    expect(out.result.status).toBe('completed');
    expect(out.result.inputSessionIds.length).toBeGreaterThan(0);
    expect(out.result.patterns.length).toBe(1);
    expect(out.result.proposedMemoryPath).toBeTruthy();
    expect(existsSync(out.result.proposedMemoryPath!)).toBe(true);

    const proposed = readFileSync(out.result.proposedMemoryPath!, 'utf-8');
    expect(proposed).toContain('Memory Index (smoke synthetic)');

    // Active patterns.md is updated for the mutation engine.
    const activePatternsPath = join(tmpEvoDir, 'dreams', 'patterns.md');
    expect(existsSync(activePatternsPath)).toBe(true);
    expect(readFileSync(activePatternsPath, 'utf-8')).toContain('PT001');

    // Live memory NOT touched.
    const liveIndex = readFileSync(join(MEMORY_DIR, 'MEMORY.md'), 'utf-8');
    expect(liveIndex).not.toContain('smoke synthetic');

    // Cleanup.
    rmSync(tmpEvoDir, { recursive: true, force: true });
  });
});
