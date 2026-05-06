import { describe, it, expect } from 'vitest';
import { buildExplorePrompt } from '../../../src/mutation/dialogue-prompts.js';
import type { MutationContext } from '../../../src/mutation/single-call.js';
import type { Scorecard } from '../../../src/scoring/chain-runner.js';

const scorecard: Scorecard = {
  total_score: 80,
  max_score: 100,
  percentage: 80,
  evaluators: [
    { name: 'judge', score: 80, max: 100, weight: 100, passed: true, error: null },
  ],
};

const baseContext: MutationContext = {
  artifact: 'You are an agent.',
  artifactType: 'prompt',
  scorecard,
  archiveHistory: [],
  metaStrategy: '# Strategy',
};

describe('dream focus areas in mutation prompts', () => {
  it('does not include the dream section when dreamFocusAreas is undefined', () => {
    const prompt = buildExplorePrompt(baseContext);
    expect(prompt).not.toContain('Dream-Surfaced Focus Areas');
  });

  it('does not include the dream section when dreamFocusAreas is empty string', () => {
    const prompt = buildExplorePrompt({ ...baseContext, dreamFocusAreas: '' });
    expect(prompt).not.toContain('Dream-Surfaced Focus Areas');
  });

  it('includes the dream section when dreamFocusAreas is provided', () => {
    const block = '## Dream-Surfaced Focus Areas\n- [high/rule] **Auth missing** — fix it.';
    const prompt = buildExplorePrompt({ ...baseContext, dreamFocusAreas: block });
    expect(prompt).toContain('Dream-Surfaced Focus Areas');
    expect(prompt).toContain('Auth missing');
  });
});
