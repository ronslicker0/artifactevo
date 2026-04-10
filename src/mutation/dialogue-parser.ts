import type { ExploreCandidate, CritiqueOutput, SpecifyOutput, MutationType } from './types.js';
import { MUTATION_TYPES } from './types.js';

// ── Parse Error ─────────────────────────────────────────────────────────

export class DialogueParseError extends Error {
  constructor(round: string, message: string) {
    super(`[${round}] ${message}`);
    this.name = 'DialogueParseError';
  }
}

// ── JSON Extraction ─────────────────────────────────────────────────────

function extractJSON(raw: string): string | null {
  // Strategy 1: Fenced code block
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();

  // Strategy 2: First { to last }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) return raw.slice(first, last + 1);

  // Strategy 3: First [ to last ]
  const firstArr = raw.indexOf('[');
  const lastArr = raw.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) return raw.slice(firstArr, lastArr + 1);

  return null;
}

// ── Round Parsers ───────────────────────────────────────────────────────

export function parseExploreResponse(raw: string): ExploreCandidate[] {
  const jsonStr = extractJSON(raw);
  if (!jsonStr) {
    throw new DialogueParseError('Explore', 'No JSON found in response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new DialogueParseError('Explore', `Invalid JSON: ${jsonStr.slice(0, 200)}`);
  }

  // Accept { candidates: [...] } or bare [...]
  let candidates: unknown[];
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (
    parsed &&
    typeof parsed === 'object' &&
    'candidates' in parsed &&
    Array.isArray((parsed as Record<string, unknown>).candidates)
  ) {
    candidates = (parsed as Record<string, unknown>).candidates as unknown[];
  } else {
    throw new DialogueParseError('Explore', 'Expected array of candidates or { candidates: [...] }');
  }

  if (candidates.length < 2 || candidates.length > 7) {
    throw new DialogueParseError('Explore', `Expected 3-5 candidates, got ${candidates.length}`);
  }

  return candidates.map((c, i) => {
    const obj = c as Record<string, unknown>;
    if (!obj.mutation_type || !obj.target || !obj.rationale) {
      throw new DialogueParseError('Explore', `Candidate ${i} missing required fields`);
    }

    const mt = String(obj.mutation_type);
    if (!MUTATION_TYPES.includes(mt as MutationType)) {
      throw new DialogueParseError('Explore', `Candidate ${i} has invalid mutation_type: ${mt}`);
    }

    return {
      mutation_type: mt as MutationType,
      target: String(obj.target),
      rationale: String(obj.rationale),
      regression_risk: validateRisk(obj.regression_risk),
    };
  });
}

export function parseCritiqueResponse(raw: string): CritiqueOutput {
  const jsonStr = extractJSON(raw);
  if (!jsonStr) {
    throw new DialogueParseError('Critique', 'No JSON found in response');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    throw new DialogueParseError('Critique', `Invalid JSON: ${jsonStr.slice(0, 200)}`);
  }

  if (typeof parsed.selected_index !== 'number') {
    throw new DialogueParseError('Critique', 'Missing or invalid selected_index');
  }
  if (typeof parsed.reasoning !== 'string') {
    throw new DialogueParseError('Critique', 'Missing or invalid reasoning');
  }
  if (!parsed.selected || typeof parsed.selected !== 'object') {
    throw new DialogueParseError('Critique', 'Missing selected candidate object');
  }

  const sel = parsed.selected as Record<string, unknown>;
  const mt = String(sel.mutation_type);
  if (!MUTATION_TYPES.includes(mt as MutationType)) {
    throw new DialogueParseError('Critique', `Invalid mutation_type in selected: ${mt}`);
  }

  return {
    selected_index: parsed.selected_index as number,
    selected: {
      mutation_type: mt as MutationType,
      target: String(sel.target),
      rationale: String(sel.rationale),
      regression_risk: validateRisk(sel.regression_risk),
    },
    reasoning: parsed.reasoning as string,
    rejected_reasons: (parsed.rejected_reasons ?? {}) as Record<number, string>,
  };
}

export function parseSpecifyResponse(raw: string): SpecifyOutput {
  const jsonStr = extractJSON(raw);
  if (!jsonStr) {
    throw new DialogueParseError('Specify', 'No JSON found in response');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    throw new DialogueParseError('Specify', `Invalid JSON: ${jsonStr.slice(0, 200)}`);
  }

  const mt = String(parsed.mutation_type);
  if (!MUTATION_TYPES.includes(mt as MutationType)) {
    throw new DialogueParseError('Specify', `Invalid mutation_type: ${mt}`);
  }
  if (typeof parsed.target_section !== 'string') {
    throw new DialogueParseError('Specify', 'Missing target_section');
  }
  if (typeof parsed.content_spec !== 'string') {
    throw new DialogueParseError('Specify', 'Missing content_spec');
  }

  const action = String(parsed.action ?? 'replace');
  const validActions = ['add', 'remove', 'replace', 'move'];
  if (!validActions.includes(action)) {
    throw new DialogueParseError('Specify', `Invalid action: ${action}`);
  }

  return {
    mutation_type: mt as MutationType,
    target_section: parsed.target_section as string,
    action: action as SpecifyOutput['action'],
    content_spec: parsed.content_spec as string,
    integration_constraints: Array.isArray(parsed.integration_constraints)
      ? (parsed.integration_constraints as unknown[]).map(String)
      : [],
    expected_score_deltas: (parsed.expected_score_deltas ?? {}) as Record<string, number>,
  };
}

export function parseGenerateResponse(raw: string): string {
  // Strategy 1: Look for ===UPDATED_ARTIFACT=== delimiter (same as single-call)
  const delimiterParts = raw.split('===UPDATED_ARTIFACT===');
  if (delimiterParts.length >= 2) {
    let artifact = delimiterParts.slice(1).join('===UPDATED_ARTIFACT===');
    const endIdx = artifact.indexOf('===END_ARTIFACT===');
    if (endIdx !== -1) artifact = artifact.slice(0, endIdx);
    const trimmed = artifact.trim();
    if (trimmed.length > 0) return trimmed;
  }

  // Strategy 2: Fenced code block
  const fenced = raw.match(/```(?:\w+)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    const trimmed = fenced[1].trim();
    if (trimmed.length > 0) return trimmed;
  }

  // Strategy 3: The entire response is the artifact (strip any leading prose)
  const trimmed = raw.trim();
  if (trimmed.length > 50) return trimmed;

  throw new DialogueParseError('Generate', 'Could not extract updated artifact from response');
}

// ── Helpers ─────────────────────────────────────────────────────────────

function validateRisk(value: unknown): 'low' | 'medium' | 'high' {
  const s = String(value ?? 'medium').toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high') return s;
  return 'medium';
}
