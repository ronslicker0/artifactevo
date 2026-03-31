// ── Mutation Type Definitions ────────────────────────────────────────────

export const MUTATION_TYPES = [
  'ADD_RULE',
  'ADD_EXAMPLE',
  'ADD_NEGATIVE_EXAMPLE',
  'REORDER',
  'SIMPLIFY',
  'REPHRASE',
  'DELETE_RULE',
  'MERGE_RULES',
  'RESTRUCTURE',
] as const;

export type MutationType = (typeof MUTATION_TYPES)[number];

export interface MutationOutput {
  diagnosis: string;
  mutation_type: MutationType;
  target_section: string;
  action: 'add' | 'remove' | 'replace' | 'move';
  content: string;
  position: string;
  expected_impact: string;
  updated_artifact: string;
}

export interface MutationResult {
  output: MutationOutput;
  diff: string;
  input_tokens: number;
  output_tokens: number;
}
