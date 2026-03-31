#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import yaml from 'js-yaml';
import { loadConfig, type EvoConfig } from '../src/core/config.js';
import { Archive, type ArchiveEntry } from '../src/core/archive.js';
import { loadArtifact } from '../src/core/artifact.js';
import { runChain } from '../src/scoring/chain-runner.js';
import { evolve } from '../src/loops/evolve.js';
import { innerLoop } from '../src/loops/inner.js';
import { createProvider } from '../src/llm/factory.js';
import { detectAntiPatterns } from '../src/detection/anti-patterns.js';
import { startDaemon, readDaemonPid } from '../src/automation/daemon.js';
import { hookTrigger } from '../src/automation/hook-trigger.js';

// ── ANSI Colors ─────────────────────────────────────────────────────────

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

// ── Config Path ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = '.evo/config.yaml';
const DEFAULT_EVO_DIR = '.evo';
const DEFAULT_ARCHIVE_PATH = '.evo/archive.jsonl';

function resolveConfigPath(opts: { config?: string }): string {
  return resolve(opts.config ?? DEFAULT_CONFIG_PATH);
}

function resolveEvoDir(): string {
  return resolve(DEFAULT_EVO_DIR);
}

// ── Program ─────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('evo')
  .description('ArtifactEvo — evolve prompts, configs, templates through trace-driven mutation loops')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to config.yaml', DEFAULT_CONFIG_PATH);

// ── init ────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize .evo/ directory with config.yaml from template')
  .option('--preset <type>', 'preset type (default: standard)', 'standard')
  .action((_opts) => {
    const evoDir = resolveEvoDir();

    if (existsSync(evoDir)) {
      console.log(yellow('Warning: .evo/ directory already exists'));
    }

    // Create directory structure
    mkdirSync(join(evoDir, 'pending'), { recursive: true });
    mkdirSync(join(evoDir, 'traces', 'runs'), { recursive: true });

    // Copy config template
    const configDest = join(evoDir, 'config.yaml');
    if (!existsSync(configDest)) {
      const templatePath = resolve(dirname(new URL(import.meta.url).pathname), '..', 'templates', 'config.template.yaml');
      if (existsSync(templatePath)) {
        copyFileSync(templatePath, configDest);
      } else {
        // Inline fallback template
        const template = `version: "1.0"\nartifacts: {}\nllm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514\n  auth_env: ANTHROPIC_API_KEY\nevolution:\n  budget_per_session: 10\n  feedback_interval: 3\n  outer_interval: 10\n  plateau_window: 5\nautomation:\n  hook_mode: false\n  daemon_mode: false\n  cooldown_minutes: 10\n  auto_commit: true\n  auto_push: false\n  max_regressions_before_pause: 3\nmeta_strategy_path: .evo/meta-strategy.md\n`;
        writeFileSync(configDest, template, 'utf-8');
      }
      console.log(green('Created .evo/config.yaml'));
    }

    // Copy meta-strategy template
    const strategyDest = join(evoDir, 'meta-strategy.md');
    if (!existsSync(strategyDest)) {
      const templatePath = resolve(dirname(new URL(import.meta.url).pathname), '..', 'templates', 'meta-strategy.template.md');
      if (existsSync(templatePath)) {
        copyFileSync(templatePath, strategyDest);
      } else {
        writeFileSync(strategyDest, '# Mutation Strategy\n\n## Priority Order\n1. ADD_RULE\n2. ADD_EXAMPLE\n3. SIMPLIFY\n', 'utf-8');
      }
      console.log(green('Created .evo/meta-strategy.md'));
    }

    // Create empty archive
    const archivePath = join(evoDir, 'archive.jsonl');
    if (!existsSync(archivePath)) {
      writeFileSync(archivePath, '', 'utf-8');
      console.log(green('Created .evo/archive.jsonl'));
    }

    console.log(green('\nArtifactEvo initialized. Next steps:'));
    console.log(dim('  1. evo add <name> <path>    — register an artifact'));
    console.log(dim('  2. evo baseline              — score artifacts'));
    console.log(dim('  3. evo evolve                — start evolving'));
  });

// ── add ─────────────────────────────────────────────────────────────────

program
  .command('add <name> <path>')
  .description('Register an artifact in config.yaml')
  .action((name: string, artifactPath: string, _opts, cmd) => {
    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    const config = loadConfig(configPath);

    if (config.artifacts[name]) {
      console.log(yellow(`Artifact "${name}" already exists in config. Updating path.`));
    }

    // Read raw YAML to preserve structure
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const artifacts = (parsed.artifacts ?? {}) as Record<string, unknown>;

    artifacts[name] = {
      path: artifactPath,
      type: 'prompt',
      scorer: {
        chain: [
          {
            name: 'placeholder',
            command: 'echo "score: 50/100"',
            weight: 1,
          },
        ],
      },
    };

    parsed.artifacts = artifacts;
    writeFileSync(configPath, yaml.dump(parsed, { lineWidth: 120 }), 'utf-8');

    console.log(green(`Added artifact "${name}" -> ${artifactPath}`));
    console.log(dim('  Edit .evo/config.yaml to configure the scorer chain.'));
  });

// ── baseline ────────────────────────────────────────────────────────────

program
  .command('baseline')
  .description('Score all/one artifact without mutation, log baseline to archive')
  .option('-a, --artifact <id>', 'specific artifact to baseline')
  .action(async (opts, cmd) => {
    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    const config = loadConfig(configPath);
    const archive = new Archive(resolve(DEFAULT_ARCHIVE_PATH));
    archive.load();

    const artifactIds = opts.artifact
      ? [opts.artifact]
      : Object.keys(config.artifacts);

    for (const id of artifactIds) {
      const artifactConfig = config.artifacts[id];
      if (!artifactConfig) {
        console.log(red(`Artifact "${id}" not found in config`));
        continue;
      }

      console.log(`Scoring ${bold(id)}...`);

      try {
        const artifact = loadArtifact(id, artifactConfig);
        const scorecard = await runChain(artifactConfig.scorer.chain, resolve('.'));

        const entry: ArchiveEntry = {
          genid: archive.getNextGenId(),
          artifact: id,
          parent: null,
          score: scorecard.total_score,
          max_score: scorecard.max_score,
          challenge: null,
          run_id: null,
          diff: null,
          mutation_type: 'BASELINE',
          mutation_desc: `Baseline score for ${id} (${artifact.lineCount} lines)`,
          status: 'baseline',
          timestamp: new Date().toISOString(),
          token_cost: null,
          automated: false,
        };

        archive.append(entry);

        console.log(
          green(`  ${id}: ${scorecard.total_score}/${scorecard.max_score} (${scorecard.percentage}%)`)
        );

        for (const ev of scorecard.evaluators) {
          const icon = ev.passed ? green('PASS') : red('FAIL');
          console.log(dim(`    ${icon} ${ev.name}: ${ev.score}/${ev.max}`));
        }
      } catch (err) {
        console.log(red(`  Error scoring ${id}: ${String(err)}`));
      }
    }
  });

// ── run ─────────────────────────────────────────────────────────────────

program
  .command('run')
  .description('Single evolution experiment')
  .option('-a, --artifact <id>', 'artifact to evolve')
  .option('--dry-run', 'propose mutation without applying')
  .option('--safe', 'revert neutral mutations too')
  .action(async (opts, cmd) => {
    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    const config = loadConfig(configPath);
    const archive = new Archive(resolve(DEFAULT_ARCHIVE_PATH));
    archive.load();
    const provider = createProvider(config.llm);

    const artifactId = opts.artifact ?? Object.keys(config.artifacts)[0];
    if (!artifactId) {
      console.error(red('No artifacts configured.'));
      process.exit(1);
    }

    const result = await innerLoop(config, artifactId, archive, provider, {
      dryRun: opts.dryRun,
      safe: opts.safe,
    });

    const statusColor = {
      success: green,
      regression: red,
      neutral: yellow,
      crash: red,
    }[result.status];

    console.log(`\n${statusColor(result.status.toUpperCase())} gen=${result.genid}`);
    console.log(`  Artifact: ${result.artifact}`);
    console.log(`  Type: ${result.mutationType}`);
    console.log(`  Score: ${result.score !== null ? `${result.score}/${result.maxScore}` : 'n/a'}`);
    console.log(`  Tokens: ${result.tokenCost}`);

    if (result.diff && opts.dryRun) {
      console.log('\n' + dim('Proposed diff (not applied):'));
      for (const line of result.diff.split('\n').slice(0, 30)) {
        if (line.startsWith('+')) console.log(green(line));
        else if (line.startsWith('-')) console.log(red(line));
        else console.log(dim(line));
      }
    }
  });

// ── evolve ──────────────────────────────────────────────────────────────

program
  .command('evolve')
  .description('Full evolution session')
  .option('-n, --budget <number>', 'experiment budget', parseInt)
  .option('-a, --artifact <id>', 'specific artifact')
  .option('--safe', 'revert neutral mutations')
  .action(async (opts, cmd) => {
    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    const config = loadConfig(configPath);

    await evolve(config, {
      budget: opts.budget,
      artifactId: opts.artifact,
      safe: opts.safe,
    });
  });

// ── status ──────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Dashboard showing scores, recent mutations, anti-patterns')
  .option('-a, --artifact <id>', 'specific artifact')
  .action((_opts, cmd) => {
    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    const config = loadConfig(configPath);
    const archive = new Archive(resolve(DEFAULT_ARCHIVE_PATH));
    archive.load();

    const allEntries = archive.getAll() as ArchiveEntry[];
    const artifactIds = _opts.artifact
      ? [_opts.artifact]
      : Object.keys(config.artifacts);

    // Header
    console.log(bold('\nArtifactEvo Status'));
    console.log('\u2550'.repeat(55));

    // Summary stats
    const totalExperiments = allEntries.length;
    const successes = allEntries.filter((e) => e.status === 'success').length;
    const regressions = allEntries.filter((e) => e.status === 'regression').length;
    const neutrals = allEntries.filter((e) => e.status === 'neutral').length;
    const totalTokens = allEntries.reduce((sum, e) => sum + (e.token_cost ?? 0), 0);

    console.log(`Artifacts: ${bold(String(artifactIds.length))} registered`);
    console.log(
      `Archive:   ${bold(String(totalExperiments))} experiments ` +
      `(${green(String(successes))} success, ${red(String(regressions))} regression, ${yellow(String(neutrals))} neutral)`
    );
    console.log(`Tokens:    ~${totalTokens.toLocaleString()} total`);
    console.log('');

    // Table
    if (artifactIds.length > 0) {
      // Column widths
      const nameWidth = Math.max(15, ...artifactIds.map((id) => id.length)) + 2;

      // Header row
      const headerLine =
        '\u250C' + '\u2500'.repeat(nameWidth) +
        '\u252C' + '\u2500'.repeat(7) +
        '\u252C' + '\u2500'.repeat(5) +
        '\u252C' + '\u2500'.repeat(10) +
        '\u252C' + '\u2500'.repeat(14) + '\u2510';
      console.log(headerLine);
      console.log(
        '\u2502' + ' Artifact'.padEnd(nameWidth) +
        '\u2502' + ' Score'.padEnd(7) +
        '\u2502' + ' Max'.padEnd(5) +
        '\u2502' + ' Mutations'.padEnd(10) +
        '\u2502' + ' Last Type'.padEnd(14) + '\u2502'
      );
      const separatorLine =
        '\u251C' + '\u2500'.repeat(nameWidth) +
        '\u253C' + '\u2500'.repeat(7) +
        '\u253C' + '\u2500'.repeat(5) +
        '\u253C' + '\u2500'.repeat(10) +
        '\u253C' + '\u2500'.repeat(14) + '\u2524';
      console.log(separatorLine);

      // Data rows
      for (const id of artifactIds) {
        const entries = allEntries.filter((e) => e.artifact === id);
        const scored = entries.filter((e) => e.score !== null);
        const bestScore = scored.length > 0
          ? Math.max(...scored.map((e) => e.score as number))
          : 0;
        const maxScore = scored.length > 0
          ? scored[scored.length - 1].max_score
          : 0;
        const mutations = entries.filter((e) => e.status !== 'baseline').length;
        const lastEntry = entries[entries.length - 1];
        const lastType = lastEntry?.mutation_type ?? 'n/a';

        console.log(
          '\u2502' + ` ${id}`.padEnd(nameWidth) +
          '\u2502' + ` ${bestScore}`.padEnd(7) +
          '\u2502' + ` ${maxScore}`.padEnd(5) +
          '\u2502' + ` ${mutations}`.padEnd(10) +
          '\u2502' + ` ${lastType}`.padEnd(14) + '\u2502'
        );
      }

      const footerLine =
        '\u2514' + '\u2500'.repeat(nameWidth) +
        '\u2534' + '\u2500'.repeat(7) +
        '\u2534' + '\u2500'.repeat(5) +
        '\u2534' + '\u2500'.repeat(10) +
        '\u2534' + '\u2500'.repeat(14) + '\u2518';
      console.log(footerLine);
    }

    // Anti-patterns
    console.log('');
    const allPatterns = artifactIds.flatMap((id) =>
      detectAntiPatterns(allEntries, id).map((p) => ({ ...p, artifact: id }))
    );

    if (allPatterns.length > 0) {
      console.log(`Anti-patterns: ${yellow(String(allPatterns.length))} warning(s)`);
      for (const p of allPatterns) {
        const icon = p.severity === 'high' ? red('!!') : yellow('!!');
        console.log(`  ${icon} ${p.type} on ${p.artifact}: ${p.message}`);
      }
    } else {
      console.log(green('Anti-patterns: none detected'));
    }
    console.log('');
  });

// ── trace ───────────────────────────────────────────────────────────────

program
  .command('trace <command...>')
  .description('Wrap command as traced run')
  .requiredOption('--artifact <id>', 'artifact to associate with trace')
  .action(async (commandParts: string[], opts) => {
    const { execSync } = await import('node:child_process');
    const { initRun, finalizeRun } = await import('../src/core/trace-store.js');

    const evoDir = resolveEvoDir();
    const artifactId = opts.artifact;
    const command = commandParts.join(' ');

    console.log(dim(`Tracing: ${command}`));
    const { runId } = initRun(evoDir, artifactId, 'cli');

    try {
      execSync(command, { stdio: 'inherit' });
      finalizeRun(evoDir, runId, 0, 0, { traced: true });
      console.log(green(`Trace ${runId} completed.`));
    } catch (err) {
      finalizeRun(evoDir, runId, 0, 0, { traced: true, error: String(err) });
      console.log(red(`Trace ${runId} failed: ${String(err)}`));
    }
  });

// ── daemon ──────────────────────────────────────────────────────────────

const daemonCmd = program.command('daemon').description('Manage automation daemon');

daemonCmd
  .command('start')
  .description('Start the automation daemon')
  .action(async (_opts, cmd) => {
    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    const config = loadConfig(configPath);
    const evoDir = resolveEvoDir();

    const existingPid = readDaemonPid(evoDir);
    if (existingPid !== null) {
      console.log(yellow(`Daemon may already be running (PID: ${existingPid})`));
      console.log(dim('Use `evo daemon stop` to stop it first.'));
      return;
    }

    await startDaemon(config, evoDir);
  });

daemonCmd
  .command('stop')
  .description('Stop the automation daemon')
  .action(() => {
    const evoDir = resolveEvoDir();
    const pid = readDaemonPid(evoDir);

    if (pid === null) {
      console.log(dim('No daemon running.'));
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(green(`Sent SIGTERM to daemon (PID: ${pid})`));
    } catch {
      console.log(yellow(`Could not signal PID ${pid} — cleaning up stale PID file.`));
      const { unlinkSync: rmSync } = require('node:fs');
      const pidFile = join(evoDir, 'daemon.pid');
      if (existsSync(pidFile)) rmSync(pidFile);
    }
  });

// ── hooks ───────────────────────────────────────────────────────────────

program
  .command('hooks')
  .description('Hook management')
  .command('install')
  .description('Install evolution hooks (placeholder)')
  .action(() => {
    console.log(yellow('Hook installation not yet implemented.'));
    console.log(dim('Hooks will be generated for Claude Code post-session triggers.'));
  });

// ── history ─────────────────────────────────────────────────────────────

program
  .command('history')
  .description('Show archive history')
  .option('-a, --artifact <id>', 'filter by artifact')
  .option('-n, --count <number>', 'number of entries to show', parseInt, 20)
  .action((_opts, cmd) => {
    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    loadConfig(configPath); // Validate config exists

    const archive = new Archive(resolve(DEFAULT_ARCHIVE_PATH));
    archive.load();

    let entries: ArchiveEntry[];
    if (_opts.artifact) {
      entries = archive.getByArtifact(_opts.artifact);
    } else {
      entries = [...archive.getAll()] as ArchiveEntry[];
    }

    // Show most recent N entries
    const count = _opts.count ?? 20;
    const recent = entries.slice(-count).reverse();

    if (recent.length === 0) {
      console.log(dim('No history entries found.'));
      return;
    }

    console.log(bold(`\nHistory (${recent.length} of ${entries.length} entries)\n`));

    for (const entry of recent) {
      const statusColor = {
        baseline: dim,
        success: green,
        regression: red,
        neutral: yellow,
        crash: red,
      }[entry.status];

      const scoreStr = entry.score !== null
        ? `${entry.score}/${entry.max_score}`
        : 'n/a';

      console.log(
        `  ${statusColor(entry.status.padEnd(10))} ` +
        `gen=${String(entry.genid).padStart(3)} ` +
        `${entry.artifact.padEnd(20)} ` +
        `${entry.mutation_type.padEnd(12)} ` +
        `score=${scoreStr.padEnd(8)} ` +
        dim(entry.timestamp.slice(0, 19))
      );
    }
    console.log('');
  });

// ── Parse ───────────────────────────────────────────────────────────────

program.parse();
