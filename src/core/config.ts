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
});

const LLMConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'claude-code']),
  model: z.string(),
  auth_env: z.string().optional(),
});

const EvolutionConfigSchema = z.object({
  budget_per_session: z.number().int().positive().default(10),
  feedback_interval: z.number().int().positive().default(3),
  outer_interval: z.number().int().positive().default(10),
  plateau_window: z.number().int().positive().default(5),
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

const EvoConfigSchema = z.object({
  version: z.string(),
  artifacts: z.record(z.string(), ArtifactConfigSchema),
  llm: LLMConfigSchema,
  evolution: EvolutionConfigSchema.default({}),
  automation: AutomationConfigSchema.default({}),
  dashboard: DashboardConfigSchema.default({}),
  meta_strategy_path: z.string().default('.evo/meta-strategy.md'),
});

// ── Exported Types ───────────────────────────────────────────────────────

export type ScorerChainItem = z.infer<typeof ScorerChainItemSchema>;
export type ArtifactConfig = z.infer<typeof ArtifactConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;
export type AutomationConfig = z.infer<typeof AutomationConfigSchema>;
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;
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
