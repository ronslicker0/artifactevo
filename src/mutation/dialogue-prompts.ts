import type { MutationContext } from './single-call.js';
import type { ExploreCandidate, SpecifyOutput } from './types.js';
import type { Scorecard } from '../scoring/chain-runner.js';

// ── Round 1: Explore ────────────────────────────────────────────────────

export function buildExplorePrompt(context: MutationContext): string {
  const scorecardBlock = context.scorecard.evaluators
    .map(
      (e) =>
        `  ${e.name}: ${e.score}/${e.max} (weight=${e.weight}, passed=${e.passed})`
    )
    .join('\n');

  const historyBlock = context.archiveHistory.length > 0
    ? context.archiveHistory
        .map(
          (e) =>
            `  gen=${e.genid} type=${e.mutation_type} status=${e.status} score=${e.score}/${e.max_score}`
        )
        .join('\n')
    : '  (no history)';

  // Per-criterion breakdown — shows the mutation LLM exactly which criteria are weak
  const checksBlock = context.scorecardChecks && context.scorecardChecks.length > 0
    ? context.scorecardChecks
        .map((c) => {
          const pct = c.max > 0 ? Math.round((c.score / c.max) * 100) : 0;
          return `  ${c.name}: ${c.score}/${c.max} (${pct}%)${c.note ? ` — ${c.note}` : ''}`;
        })
        .join('\n')
    : null;

  // Rubric content — shows what the judge is actually scoring on
  const rubricBlock = context.rubricContent
    ? `\n## Judge Rubric (what the scorer evaluates)\n${context.rubricContent}\n`
    : '';

  return `You are a Kultiv evolution engine performing the EXPLORE phase. Your job is to brainstorm 3-5 candidate improvements for the artifact below.

## Meta-Strategy
${context.metaStrategy}

## Artifact Type: ${context.artifactType}

## Current Artifact
\`\`\`
${context.artifact}
\`\`\`

## Current Scorecard (${context.scorecard.percentage.toFixed(1)}%)
${scorecardBlock}
${checksBlock ? `\n### Per-Criterion Breakdown\n${checksBlock}` : ''}
${rubricBlock}
## Recent Archive History (last ${context.archiveHistory.length})
${historyBlock}

## Task: EXPLORE

Analyze the artifact and scorecard. Brainstorm 3-5 candidate improvements. Each candidate MUST use a DIFFERENT mutation type. Consider:
- Which SPECIFIC CRITERIA are scoring lowest? Target those first.
- Read the rubric tier descriptions — what does the NEXT tier up require?
- What mutation types from the meta-strategy priority order fit best?
- What is the regression risk of each candidate?
- Avoid repeating mutation types from recent history unless strongly justified.
- CRITICAL: Do NOT restructure or reorder the artifact unless a criterion specifically requires it. Prefer ADD_RULE or ADD_EXAMPLE that inject new content into the existing structure without disrupting what already works.

Respond with a JSON code block:

\`\`\`json
{
  "candidates": [
    {
      "mutation_type": "ADD_RULE|ADD_EXAMPLE|ADD_NEGATIVE_EXAMPLE|REORDER|SIMPLIFY|REPHRASE|DELETE_RULE|MERGE_RULES|RESTRUCTURE",
      "target": "which section or area to modify",
      "rationale": "why this change would improve the score — connect to specific failing evaluators",
      "regression_risk": "low|medium|high"
    }
  ]
}
\`\`\``;
}

// ── Round 2: Critique ───────────────────────────────────────────────────

export function buildCritiquePrompt(candidates: ExploreCandidate[]): string {
  const candidateList = candidates
    .map(
      (c, i) =>
        `  ${i}. [${c.mutation_type}] target="${c.target}" risk=${c.regression_risk}\n     Rationale: ${c.rationale}`
    )
    .join('\n\n');

  return `## Task: CRITIQUE

You proposed these candidates in the Explore phase:

${candidateList}

Now evaluate each candidate against these criteria:
1. **Regression risk** — Could this change break something that currently works?
2. **Redundancy** — Does this duplicate a recent mutation that was already tried (check the archive history from the Explore phase)?
3. **Root-cause fit** — Does this address the actual reason an evaluator is failing, or just a symptom?
4. **Diversity** — Does this avoid type fixation (repeating the same mutation pattern)?

Select the SINGLE BEST candidate. Explain why you chose it and why you rejected the others.

Respond with a JSON code block:

\`\`\`json
{
  "selected_index": 0,
  "selected": {
    "mutation_type": "...",
    "target": "...",
    "rationale": "...",
    "regression_risk": "low|medium|high"
  },
  "reasoning": "why this candidate is the best choice",
  "rejected_reasons": {
    "1": "why candidate 1 was rejected",
    "2": "why candidate 2 was rejected"
  }
}
\`\`\``;
}

// ── Round 3: Specify ────────────────────────────────────────────────────

export function buildSpecifyPrompt(
  selected: ExploreCandidate,
  artifact: string,
  scorecard: Scorecard,
): string {
  const evaluatorNames = scorecard.evaluators.map((e) => e.name);

  return `## Task: SPECIFY

You selected this candidate:
- **Type:** ${selected.mutation_type}
- **Target:** ${selected.target}
- **Rationale:** ${selected.rationale}
- **Risk:** ${selected.regression_risk}

Now write a precise specification for this mutation. Be exact about what to change so the Generate phase can execute it precisely.

Current artifact for reference:
\`\`\`
${artifact}
\`\`\`

Respond with a JSON code block:

\`\`\`json
{
  "mutation_type": "${selected.mutation_type}",
  "target_section": "exact section name or line range to modify",
  "action": "add|remove|replace|move",
  "content_spec": "the exact content to add, remove, or replace — be specific enough that the change is unambiguous",
  "integration_constraints": [
    "things that must NOT be broken by this change"
  ],
  "expected_score_deltas": {
    ${evaluatorNames.map((n) => `"${n}": 0`).join(',\n    ')}
  }
}
\`\`\``;
}

// ── Round 4: Generate ───────────────────────────────────────────────────

export function buildGeneratePrompt(spec: SpecifyOutput, artifact: string): string {
  return `## Task: GENERATE

Apply the following specification to produce the updated artifact.

**Specification:**
- **Type:** ${spec.mutation_type}
- **Target:** ${spec.target_section}
- **Action:** ${spec.action}
- **Change:** ${spec.content_spec}
- **Constraints:** ${spec.integration_constraints.length > 0 ? spec.integration_constraints.join('; ') : 'none'}

**Current artifact:**
\`\`\`
${artifact}
\`\`\`

**Rules:**
- Apply EXACTLY ONE change matching the specification above.
- Do NOT make any other modifications, improvements, or fixes beyond what the spec describes.
- Output the COMPLETE updated artifact — the entire file, not just the changed part.
- Respect all integration constraints.

===UPDATED_ARTIFACT===
(paste the COMPLETE updated artifact content here)
===END_ARTIFACT===`;
}
