import type { LLMProvider, LLMMessage } from '../llm/provider.js';
import type { MutationResult, ExploreCandidate, CritiqueOutput, SpecifyOutput, DialogueTrace } from './types.js';
import type { MutationContext } from './single-call.js';
import { proposeMutation as singleCallFallback } from './single-call.js';
import {
  buildExplorePrompt,
  buildCritiquePrompt,
  buildSpecifyPrompt,
  buildGeneratePrompt,
} from './dialogue-prompts.js';
import {
  parseExploreResponse,
  parseCritiqueResponse,
  parseSpecifyResponse,
  parseGenerateResponse,
  DialogueParseError,
} from './dialogue-parser.js';

// ── Dialogue Mutation Proposer ──────────────────────────────────────────

/**
 * Propose a mutation via a 4-round structured dialogue:
 *   Explore → Critique → Specify → Generate
 *
 * Each round is a separate LLM call. The conversation grows so later rounds
 * see all prior reasoning. Falls back to single-call on parse failure.
 */
export async function proposeDialogueMutation(
  context: MutationContext,
  provider: LLMProvider,
): Promise<MutationResult> {
  const messages: LLMMessage[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let roundsCompleted = 0;

  try {
    // ── Round 1: Explore ──────────────────────────────────────────────
    const explorePrompt = buildExplorePrompt(context);
    messages.push({ role: 'user', content: explorePrompt });

    const exploreResponse = await provider.generate(messages, {
      temperature: 0.8,
      maxTokens: 2048,
    });
    totalInputTokens += exploreResponse.input_tokens;
    totalOutputTokens += exploreResponse.output_tokens;
    messages.push({ role: 'assistant', content: exploreResponse.content });
    roundsCompleted = 1;

    const candidates: ExploreCandidate[] = parseExploreResponse(exploreResponse.content);

    // ── Round 2: Critique ─────────────────────────────────────────────
    const critiquePrompt = buildCritiquePrompt(candidates);
    messages.push({ role: 'user', content: critiquePrompt });

    const critiqueResponse = await provider.generate(messages, {
      temperature: 0.4,
      maxTokens: 2048,
    });
    totalInputTokens += critiqueResponse.input_tokens;
    totalOutputTokens += critiqueResponse.output_tokens;
    messages.push({ role: 'assistant', content: critiqueResponse.content });
    roundsCompleted = 2;

    const critique: CritiqueOutput = parseCritiqueResponse(critiqueResponse.content);

    // ── Round 3: Specify ──────────────────────────────────────────────
    const specifyPrompt = buildSpecifyPrompt(
      critique.selected,
      context.artifact,
      context.scorecard,
    );
    messages.push({ role: 'user', content: specifyPrompt });

    const specifyResponse = await provider.generate(messages, {
      temperature: 0.3,
      maxTokens: 2048,
    });
    totalInputTokens += specifyResponse.input_tokens;
    totalOutputTokens += specifyResponse.output_tokens;
    messages.push({ role: 'assistant', content: specifyResponse.content });
    roundsCompleted = 3;

    const spec: SpecifyOutput = parseSpecifyResponse(specifyResponse.content);

    // ── Round 4: Generate ─────────────────────────────────────────────
    const generatePrompt = buildGeneratePrompt(spec, context.artifact);
    messages.push({ role: 'user', content: generatePrompt });

    const generateResponse = await provider.generate(messages, {
      temperature: 0.2,
      maxTokens: 8192,
    });
    totalInputTokens += generateResponse.input_tokens;
    totalOutputTokens += generateResponse.output_tokens;
    roundsCompleted = 4;

    const updatedArtifact = parseGenerateResponse(generateResponse.content);

    // ── Build diagnosis from dialogue reasoning ───────────────────────
    const candidateSummary = candidates
      .map((c, i) => `${i}. [${c.mutation_type}] ${c.target}: ${c.rationale} (risk: ${c.regression_risk})`)
      .join('\n');

    const diagnosis =
      `[Explore] ${candidates.length} candidates considered:\n${candidateSummary}\n\n` +
      `[Critique] Selected: [${critique.selected.mutation_type}] ${critique.selected.target}\n` +
      `Reasoning: ${critique.reasoning}\n\n` +
      `[Specify] ${spec.content_spec}`;

    // ── Build trace for archive ───────────────────────────────────────
    const trace: DialogueTrace = {
      explore_candidates: candidates,
      selected_candidate: critique.selected,
      critique_reasoning: critique.reasoning,
      specification: spec.content_spec,
      rounds_completed: roundsCompleted,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
    };

    return {
      output: {
        diagnosis,
        mutation_type: spec.mutation_type,
        target_section: spec.target_section,
        action: spec.action,
        content: spec.content_spec,
        position: spec.target_section,
        expected_impact: Object.entries(spec.expected_score_deltas)
          .map(([name, delta]) => `${name}: ${delta >= 0 ? '+' : ''}${delta}`)
          .join(', ') || 'improvement expected based on dialogue reasoning',
        updated_artifact: updatedArtifact,
      },
      diff: '',
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      dialogue_trace: trace,
    };
  } catch (err) {
    // Fallback to single-call on any dialogue failure
    if (err instanceof DialogueParseError) {
      console.warn(
        `Dialogue round failed (${err.message}), falling back to single-call mutation.`,
      );
    } else {
      console.warn(
        `Dialogue error: ${String(err)}, falling back to single-call mutation.`,
      );
    }
    return singleCallFallback(context, provider);
  }
}
