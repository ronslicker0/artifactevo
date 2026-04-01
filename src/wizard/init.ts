import { select, input, password, confirm } from '@inquirer/prompts';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { PRESETS } from './presets.js';
import { testConnection } from '../llm/test-connection.js';

// ── ANSI Helpers ───────────────────────────────────────────────────────

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

// ── Init Wizard ────────────────────────────────────────────────────────

export async function runInitWizard(evoDir: string): Promise<void> {
  console.log('\n' + bold('ArtifactEvo Setup Wizard') + '\n');
  console.log(dim('Configure your evolution environment step by step.\n'));

  // Step 1: Choose LLM provider
  const provider = await select({
    message: 'Choose LLM provider:',
    choices: [
      { name: 'Anthropic (Claude)', value: 'anthropic' as const },
      { name: 'OpenAI (GPT)', value: 'openai' as const },
      { name: 'Ollama (local)', value: 'ollama' as const },
      { name: 'Claude Code CLI', value: 'claude-code' as const },
    ],
  });

  // Step 2: Model name
  const defaultModels: Record<string, string> = {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    ollama: 'llama3.2',
    'claude-code': 'claude-sonnet-4-20250514',
  };

  const model = await input({
    message: 'Model name:',
    default: defaultModels[provider],
  });

  // Step 3: Credentials (provider-specific)
  let authType: 'api_key' | 'oauth_token' = 'api_key';
  let credential: string | undefined;
  let baseUrl: string | undefined;

  if (provider === 'anthropic' || provider === 'openai') {
    authType = await select({
      message: 'Authentication method:',
      choices: [
        { name: 'API Key', value: 'api_key' as const },
        { name: 'OAuth Token', value: 'oauth_token' as const },
      ],
    });

    credential = await password({
      message: authType === 'api_key' ? 'Enter your API key:' : 'Enter your OAuth token:',
    });

    if (!credential) {
      console.log(yellow('No credential provided. You can add it later in .evo/config.yaml'));
    }
  } else if (provider === 'ollama') {
    baseUrl = await input({
      message: 'Ollama server URL:',
      default: 'http://localhost:11434',
    });
  }
  // claude-code needs no credentials

  // Step 4: Test connection
  if (credential || provider === 'ollama' || provider === 'claude-code') {
    const shouldTest = await confirm({
      message: 'Test connection now?',
      default: true,
    });

    if (shouldTest) {
      console.log(dim('Testing connection...'));
      const testConfig = {
        provider,
        model,
        ...(authType === 'api_key' && credential ? { api_key: credential } : {}),
        ...(authType === 'oauth_token' && credential ? { oauth_token: credential } : {}),
        ...(baseUrl ? { base_url: baseUrl } : {}),
      };

      const result = await testConnection(testConfig);
      if (result.success) {
        console.log(green(`  Connected! Response: "${result.message}" (${result.latencyMs}ms)`));
      } else {
        console.log(red(`  Connection failed: ${result.message}`));
        const proceed = await confirm({
          message: 'Continue anyway?',
          default: true,
        });
        if (!proceed) {
          console.log(dim('Setup cancelled.'));
          return;
        }
      }
    }
  }

  // Step 5: Choose preset
  const _preset = await select({
    message: 'Project type (determines default scorers):',
    choices: Object.entries(PRESETS).map(([key, val]) => ({
      name: val.label,
      value: key,
    })),
  });

  // Step 6: Create .evo/ directory structure
  mkdirSync(join(evoDir, 'pending'), { recursive: true });
  mkdirSync(join(evoDir, 'traces', 'runs'), { recursive: true });

  // Step 7: Write config.yaml
  const config: Record<string, unknown> = {
    version: '1.0',
    artifacts: {},
    llm: {
      provider,
      model,
      ...(authType === 'api_key' && credential ? { api_key: credential } : {}),
      ...(authType === 'oauth_token' && credential ? { oauth_token: credential } : {}),
      ...(baseUrl ? { base_url: baseUrl } : {}),
    },
    evolution: {
      budget_per_session: 10,
      feedback_interval: 3,
      outer_interval: 10,
      plateau_window: 5,
    },
    automation: {
      hook_mode: false,
      daemon_mode: false,
      cooldown_minutes: 10,
      auto_commit: true,
      auto_push: false,
      max_regressions_before_pause: 3,
    },
    dashboard: {
      port: 4200,
      open_browser: true,
    },
    meta_strategy_path: '.evo/meta-strategy.md',
  };

  const configPath = join(evoDir, 'config.yaml');
  writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }), 'utf-8');
  console.log(green('  Created .evo/config.yaml'));

  // Copy meta-strategy template
  const strategyDest = join(evoDir, 'meta-strategy.md');
  if (!existsSync(strategyDest)) {
    writeFileSync(
      strategyDest,
      '# Mutation Strategy\n\n## Priority Order\n1. ADD_RULE\n2. ADD_EXAMPLE\n3. SIMPLIFY\n',
      'utf-8',
    );
    console.log(green('  Created .evo/meta-strategy.md'));
  }

  // Create empty archive
  const archivePath = join(evoDir, 'archive.jsonl');
  if (!existsSync(archivePath)) {
    writeFileSync(archivePath, '', 'utf-8');
    console.log(green('  Created .evo/archive.jsonl'));
  }

  // Step 8: Print next steps
  console.log('\n' + green(bold('ArtifactEvo initialized!')) + '\n');
  console.log('Next steps:');
  console.log(dim('  1. evo add <name> <path>     Register an artifact to evolve'));
  console.log(dim('  2. evo baseline              Score your artifact'));
  console.log(dim('  3. evo evolve -n 10          Run 10 evolution experiments'));
  console.log(dim('  4. evo dashboard             Open the web dashboard'));
  console.log('');

  if (credential) {
    console.log(yellow('  Note: Your credential is stored in .evo/config.yaml.'));
    console.log(yellow('  Make sure .evo/ is in your .gitignore!'));
  }
}
