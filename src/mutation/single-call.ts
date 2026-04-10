import type { LLMProvider } from '../llm/provider.js';
import type { Scorecard } from '../scoring/chain-runner.js';
import type { ArchiveEntry } from '../core/archive.js';
import type { MutationResult, MutationOutput } from './types.js';

// ── Mutation Context ────────────────────────────────────────────────────

export interface MutationContext {
  artifact: string;
  artifactType: string;
  scorecard: Scorecard;
  archiveHistory: ArchiveEntry[];
  metaStrategy: string;
  /** Rubric content (markdown) so mutation LLM knows what the judge scores on */
  rubricContent?: string;
  /** Per-criterion breakdown from last scoring run */
  scorecardChecks?: Array<{ name: string; score: number; max: number; note?: string }>;
}

// ── Single-Call Mutation Proposer ────────────────────────────────────────

/**
 * Propose a mutation via a single LLM call.
 *
 * Builds a prompt from the mutation context (artifact content, current scorecard,
 * recent archive history, and meta-strategy), sends it to the LLM, and parses
 * the structured mutation output.
 */
export async function proposeMutation(
  context: MutationContext,
  provider: LLMProvider,
): Promise<MutationResult> {
  const prompt = buildMutationPrompt(context);

  const systemPreamble =
    'You are a Kultiv evolution engine. Analyze the artifact, scorecard, and history, ' +
    'then propose exactly ONE mutation following the meta-strategy. ' +
    'Respond with a JSON code block containing mutation metadata, then the full updated artifact after an ===UPDATED_ARTIFACT=== delimiter. ' +
    'CRITICAL: The "mutation_type" MUST be one of: ADD_RULE, ADD_EXAMPLE, ADD_NEGATIVE_EXAMPLE, REORDER, SIMPLIFY, REPHRASE, DELETE_RULE, MERGE_RULES, RESTRUCTURE. No other values.';

  const response = await provider.generate([
    { role: 'user', content: `${systemPreamble}\n\n${prompt}` },
  ]);

  const output = parseMutationOutput(response.content);

  // Compute diff placeholder — caller will compute real diff
  return {
    output,
    diff: '',
    input_tokens: response.input_tokens,
    output_tokens: response.output_tokens,
  };
}

// ── Prompt Builder ──────────────────────────────────────────────────────

function buildMutationPrompt(context: MutationContext): string {
  const historyBlock = context.archiveHistory.length > 0
    ? context.archiveHistory
        .map(
          (e) =>
            `  gen=${e.genid} type=${e.mutation_type} status=${e.status} score=${e.score}/${e.max_score}`
        )
        .join('\n')
    : '  (no history)';

  const scorecardBlock = context.scorecard.evaluators
    .map(
      (e) =>
        `  ${e.name}: ${e.score}/${e.max} (weight=${e.weight}, passed=${e.passed})`
    )
    .join('\n');

  return `## Meta-Strategy
${context.metaStrategy}

## Artifact Type: ${context.artifactType}

## Current Artifact
\`\`\`
${context.artifact}
\`\`\`

## Current Scorecard (${context.scorecard.percentage}%)
${scorecardBlock}

## Recent Archive History (last ${context.archiveHistory.length})
${historyBlock}

## Task
Analyze the artifact and scorecard. Propose ONE mutation that will improve the score.
Follow the meta-strategy's priority order and diversity rules.

Use this EXACT format — a JSON block followed by the full updated artifact after a separator:

\`\`\`json
{
  "diagnosis": "brief analysis of current weaknesses",
  "mutation_type": "ADD_RULE|ADD_EXAMPLE|ADD_NEGATIVE_EXAMPLE|REORDER|SIMPLIFY|REPHRASE|DELETE_RULE|MERGE_RULES|RESTRUCTURE",
  "target_section": "which section to modify",
  "action": "add|remove|replace|move",
  "content": "the specific content being added/modified",
  "position": "where in the artifact",
  "expected_impact": "what score improvement is expected and why"
}
\`\`\`

===UPDATED_ARTIFACT===
(paste the COMPLETE updated artifact content here — the entire file, not just the changed part)
===END_ARTIFACT===`;
}

// ── Output Parser ───────────────────────────────────────────────────────

function parseMutationOutput(raw: string): MutationOutput {
  const text = raw.trim();

  // Strategy 1: Split on ===UPDATED_ARTIFACT=== delimiter
  const delimiterMatch = text.split('===UPDATED_ARTIFACT===');
  if (delimiterMatch.length >= 2) {
    const metadataPart = delimiterMatch[0].trim();
    let artifactPart = delimiterMatch.slice(1).join('===UPDATED_ARTIFACT===');
    // Strip ===END_ARTIFACT=== if present
    const endIdx = artifactPart.indexOf('===END_ARTIFACT===');
    if (endIdx !== -1) {
      artifactPart = artifactPart.slice(0, endIdx);
    }
    artifactPart = artifactPart.trim();

    // Extract JSON from the metadata part
    const jsonBlockMatch = metadataPart.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    let jsonStr = jsonBlockMatch ? jsonBlockMatch[1].trim() : metadataPart;

    // Find JSON object in the string
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      throw new Error(`Failed to parse mutation metadata JSON:\n${jsonStr.slice(0, 500)}`);
    }

    // Inject the artifact from the delimiter block
    parsed['updated_artifact'] = artifactPart;
    return validateAndReturn(parsed);
  }

  // Strategy 2: Legacy — try to parse entire response as JSON (with updated_artifact inline)
  let jsonStr = text;
  const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(jsonStr.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
      } catch {
        throw new Error(`Failed to parse mutation output as JSON:\n${raw.slice(0, 500)}`);
      }
    } else {
      throw new Error(`Failed to parse mutation output as JSON:\n${raw.slice(0, 500)}`);
    }
  }

  return validateAndReturn(parsed);
}

function validateAndReturn(parsed: Record<string, unknown>): MutationOutput {
  const required = [
    'diagnosis',
    'mutation_type',
    'target_section',
    'action',
    'content',
    'position',
    'expected_impact',
    'updated_artifact',
  ] as const;

  for (const field of required) {
    if (typeof parsed[field] !== 'string') {
      throw new Error(`Mutation output missing or invalid field: ${field}`);
    }
  }

  return parsed as unknown as MutationOutput;
}
