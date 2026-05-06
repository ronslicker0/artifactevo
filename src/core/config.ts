import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

// ── Zod Schemas ──────────────────────────────────────────────────────────

const ScorerChainItemSchema = z.object({
  name: z.string(),
  command: z.string().optional(),
  type: z.enum(['script', 'pattern', 'llm-judge']).optional(),
  rules_file: z.string().optional(),
  weight: z.number().min(0),
});

const ArtifactConfigSchema = z.object({
  path: z.string(),
  type: z.enum(['prompt', 'config', 'template', 'doc']),
  scorer: z.object({
    chain: z.array(ScorerChainItemSchema).min(1),
  }),
  challenges_dir: z.string().optional(),
  auto_generate_challenges: z.boolean().default(false),
});

const LLMConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'ollama', 'claude-code']),
  model: z.string(),
  api_key: z.string().optional(),
  auth_env: z.string().optional(),
  oauth_token: z.string().optional(),
  oauth_token_env: z.string().optional(),
  base_url: z.string().optional(),
});

const SelectionConfigSchema = z.object({
  parent_method: z.enum(['tournament', 'greedy']).default('tournament'),
  parent_temperature: z.number().positive().default(2.0),
  challenge_method: z.enum(['curriculum', 'min_score', 'round_robin']).default('curriculum'),
});

const EvolutionConfigSchema = z.object({
  budget_per_session: z.number().int().positive().default(10),
  feedback_interval: z.number().int().positive().default(3),
  outer_interval: z.number().int().positive().default(10),
  plateau_window: z.number().int().positive().default(5),
  mutation_mode: z.enum(['single', 'dialogue']).default('dialogue'),
  beam_width: z.number().int().min(1).max(10).default(3),
  cross_validation_count: z.number().int().min(0).max(5).default(2),
  selection: SelectionConfigSchema.default({}),
});

const FeedbackConfigSchema = z.object({
  deterministic_interval: z.number().int().positive().default(3),
  llm_reflection_interval: z.number().int().positive().default(6),
  llm_reflection_enabled: z.boolean().default(true),
});

const OuterLoopConfigSchema = z.object({
  mode: z.enum(['dialogue', 'single']).default('dialogue'),
  validation_batch_size: z.number().int().min(1).max(10).default(3),
});

const AutomationConfigSchema = z.object({
  hook_mode: z.boolean().default(false),
  daemon_mode: z.boolean().default(false),
  daemon_schedule: z.string().optional(),
  trigger_after: z.number().int().nonnegative().default(1),
  cooldown_minutes: z.number().int().nonnegative().default(10),
  auto_commit: z.boolean().default(true),
  auto_push: z.boolean().default(false),
  max_regressions_before_pause: z.number().int().positive().default(3),
});

const DashboardConfigSchema = z.object({
  port: z.number().int().positive().default(4200),
  open_browser: z.boolean().default(true),
});

const DreamingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Path to the markdown memory tier the dreamer consolidates. */
  memory_dir: z.string().optional(),
  /** Path to Claude Code session JSONL files. */
  sessions_dir: z.string().optional(),
  /** Override the model for dreaming (otherwise reuse the top-level llm config). */
  model: z.string().optional(),
  /** Max number of recent sessions fed to the dreamer per run. */
  max_sessions: z.number().int().min(1).max(100).default(20),
  /** Lookback window in days for session selection. */
  within_days: z.number().int().min(1).max(180).default(14),
  /** Cooldown hours between scheduled dream runs. */
  cooldown_hours: z.number().int().min(1).max(168).default(6),
  /** Auto-apply proposed memory updates without manual review. Default false. */
  auto_apply: z.boolean().default(false),
  /** Optional cron-like schedule for daemon-driven dreams. */
  schedule: z.string().optional(),
  /** USD per million input tokens for cost estimation. */
  input_cost_per_mtok: z.number().nonnegative().default(3),
  /** USD per million output tokens for cost estimation. */
  output_cost_per_mtok: z.number().nonnegative().default(15),
  /** Optional per-run instructions appended to the dream prompt. */
  instructions: z.string().optional(),
});

const EvoConfigSchema = z.object({
  version: z.string(),
  artifacts: z.record(z.string(), ArtifactConfigSchema),
  llm: LLMConfigSchema,
  evolution: EvolutionConfigSchema.default({}),
  feedback: FeedbackConfigSchema.default({}),
  outer_loop: OuterLoopConfigSchema.default({}),
  automation: AutomationConfigSchema.default({}),
  dashboard: DashboardConfigSchema.default({}),
  dreaming: DreamingConfigSchema.default({}),
  meta_strategy_path: z.string().default('.kultiv/meta-strategy.md'),
});

// ── Exported Types ───────────────────────────────────────────────────────

export type ScorerChainItem = z.infer<typeof ScorerChainItemSchema>;
export type ArtifactConfig = z.infer<typeof ArtifactConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type SelectionConfig = z.infer<typeof SelectionConfigSchema>;
export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;
export type FeedbackConfig = z.infer<typeof FeedbackConfigSchema>;
export type OuterLoopConfig = z.infer<typeof OuterLoopConfigSchema>;
export type AutomationConfig = z.infer<typeof AutomationConfigSchema>;
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;
export type DreamingConfig = z.infer<typeof DreamingConfigSchema>;
export type EvoConfig = z.infer<typeof EvoConfigSchema>;

// ── Loader ───────────────────────────────────────────────────────────────

export function loadConfig(configPath: string): EvoConfig {
  const absolutePath = resolve(configPath);

  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Config file not found: ${absolutePath}`);
    }
    throw new Error(`Failed to read config file: ${absolutePath} — ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in config file: ${absolutePath} — ${String(err)}`);
  }

  const result = EvoConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config validation failed:\n${issues}`);
  }

  return result.data;
}
