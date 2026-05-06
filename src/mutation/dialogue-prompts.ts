import type { MutationContext } from './single-call.js';
import type { ExploreCandidate, SpecifyOutput } from './types.js';
import type { Scorecard } from '../scoring/chain-runner.js';
import type { ArchiveEntry } from '../core/archive.js';

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
<artifact>
${context.artifact}
</artifact>

## Current Scorecard (${context.scorecard.percentage.toFixed(1)}%)
${scorecardBlock}
${checksBlock ? `\n### Per-Criterion Breakdown\n${checksBlock}` : ''}
${rubricBlock}
${buildFailureSection(context)}${buildScanSection(context)}${buildDreamSection(context)}## Recent Archive History (last ${context.archiveHistory.length})
${historyBlock}

## Task: EXPLORE

Analyze the artifact and scorecard. Brainstorm 3-5 candidate improvements. Each candidate MUST use a DIFFERENT mutation type. Consider:
- Which SPECIFIC CRITERIA are scoring lowest? Target those first.
- Read the rubric tier descriptions — what does the NEXT tier up require?
${context.failureContext ? '- PRIORITY: At least ONE candidate MUST directly address a production failure pattern listed above.\n' : ''}- What mutation types from the meta-strategy priority order fit best?
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

export function buildCritiquePrompt(
  candidates: ExploreCandidate[],
  scorecard?: Scorecard,
  archiveHistory?: ArchiveEntry[],
): string {
  const candidateList = candidates
    .map(
      (c, i) =>
        `  ${i}. [${c.mutation_type}] target="${c.target}" risk=${c.regression_risk}\n     Rationale: ${c.rationale}`
    )
    .join('\n\n');

  // Build optional scorecard context section
  let scorecardSection = '';
  if (scorecard) {
    const evalLines = scorecard.evaluators
      .map((e) => `  ${e.name}: ${e.score}/${e.max} (weight=${e.weight}, passed=${e.passed})`)
      .join('\n');
    scorecardSection = `\n## Current Scorecard (${scorecard.percentage.toFixed(1)}%)\n${evalLines}\n`;
  }

  // Build optional archive history section
  let historySection = '';
  if (archiveHistory && archiveHistory.length > 0) {
    const historyLines = archiveHistory
      .map((e) => `  gen=${e.genid} type=${e.mutation_type} status=${e.status} score=${e.score}/${e.max_score}`)
      .join('\n');
    historySection = `\n## Recent Archive History (last ${archiveHistory.length})\n${historyLines}\n`;
  }

  return `## Task: CRITIQUE
${scorecardSection}${historySection}
You proposed these candidates in the Explore phase:

${candidateList}

Now evaluate each candidate against these criteria:
1. **Regression risk** — Could this change break something that currently works?
2. **Redundancy** — Does this duplicate a recent mutation that was already tried (check the archive history)?
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
<artifact>
${artifact}
</artifact>

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

export function buildGeneratePrompt(spec: SpecifyOutput, artifact: string, beamWidth?: number): string {
  const effectiveBeamWidth = beamWidth && beamWidth > 1 ? beamWidth : 1;

  const basePrompt = `## Task: GENERATE

Apply the following specification to produce the updated artifact.

**Specification:**
- **Type:** ${spec.mutation_type}
- **Target:** ${spec.target_section}
- **Action:** ${spec.action}
- **Change:** ${spec.content_spec}
- **Constraints:** ${spec.integration_constraints.length > 0 ? spec.integration_constraints.join('; ') : 'none'}

**Current artifact:**
<artifact>
${artifact}
</artifact>

**Rules:**
- Apply EXACTLY ONE change matching the specification above.
- Do NOT make any other modifications, improvements, or fixes beyond what the spec describes.
- Output the COMPLETE updated artifact — the entire file, not just the changed part.
- Respect all integration constraints.
- CRITICAL SIZE CONSTRAINT: The updated artifact must be within 30% of the original length. If the spec says REPHRASE or SIMPLIFY, the output should be roughly the same size or smaller. Do NOT expand sections significantly — a "rephrase" that doubles a section's length is a rewrite, not a rephrase.
- PRESERVE STRUCTURE: Keep all existing headings, sections, and formatting intact unless the spec explicitly says to change them. Only modify the targeted section.`;

  if (effectiveBeamWidth === 1) {
    return `${basePrompt}

===UPDATED_ARTIFACT===
(paste the COMPLETE updated artifact content here)
===END_ARTIFACT===`;
  }

  // Multi-variant beam mode
  const variantInstructions = Array.from({ length: effectiveBeamWidth }, (_, i) => {
    const n = i + 1;
    return `===VARIANT_${n}===\n(paste COMPLETE variant ${n} here)\n===END_VARIANT_${n}===`;
  }).join('\n\n');

  return `${basePrompt}

**BEAM MODE: Produce ${effectiveBeamWidth} distinct variants of the updated artifact.**
Each variant must apply the same specification but explore a DIFFERENT phrasing, structure, or emphasis. The variants should be meaningfully different from each other while all satisfying the spec.

Output each variant using these delimiters:

${variantInstructions}`;
}

// ── Context Section Builders ────────────────────────────────────────────

function buildFailureSection(context: MutationContext): string {
  if (!context.failureContext || context.failureContext.recentErrors.length === 0) return '';
  const errors = context.failureContext.recentErrors
    .map((e) => `- **[${e.category}]** ${e.error}${e.errorPatterns?.length ? `\n  Patterns: ${e.errorPatterns.join(', ')}` : ''}`)
    .join('\n');
  return `## Recent Production Failures\nThese are real errors this agent caused in production. Mutations should fix these:\n${errors}\n\n`;
}

function buildScanSection(context: MutationContext): string {
  if (!context.scanAnalysis) return '';
  const recs = context.scanAnalysis.recommendations
    .filter((r) => r.priority !== 'low')
    .map((r) => `- [${r.priority}] **${r.type}**: ${r.target} — ${r.rationale}`)
    .join('\n');
  return `## Agent Analysis (from kultiv scan)\nPurpose: ${context.scanAnalysis.purpose}\nDomain: ${context.scanAnalysis.domain}\n${recs ? `\n### Recommendations\n${recs}\n` : ''}\n`;
}

function buildDreamSection(context: MutationContext): string {
  if (!context.dreamFocusAreas || context.dreamFocusAreas.trim().length === 0) return '';
  return `${context.dreamFocusAreas.trim()}\n\n`;
}
