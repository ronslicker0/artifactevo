#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { runInitWizard } from '../src/wizard/init.js';

// ── ANSI Colors ─────────────────────────────────────────────────────────

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

// ── Config Path ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = '.kultiv/config.yaml';
const DEFAULT_KULTIV_DIR = '.kultiv';
const DEFAULT_ARCHIVE_PATH = '.kultiv/archive.jsonl';

function resolveConfigPath(opts: { config?: string }): string {
  return resolve(opts.config ?? DEFAULT_CONFIG_PATH);
}

function resolveKultivDir(): string {
  return resolve(DEFAULT_KULTIV_DIR);
}

// ── Program ─────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('kultiv')
  .description('Kultiv — cultivate your agents by tweaking instructions, testing what works, and keeping the winners')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to config.yaml', DEFAULT_CONFIG_PATH);

// ── init ────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize .kultiv/ directory with config.yaml from template')
  .option('--preset <type>', 'preset type (default: standard)', 'standard')
  .option('--no-interactive', 'skip interactive wizard')
  .action(async (opts) => {
    const kultivDir = resolveKultivDir();

    if (existsSync(kultivDir)) {
      console.log(yellow('Warning: .kultiv/ directory already exists'));
    }

    // Interactive wizard when running in a TTY and not explicitly disabled
    if (process.stdin.isTTY && opts.interactive !== false) {
      await runInitWizard(kultivDir);
      return;
    }

    // Non-interactive fallback
    // Create directory structure
    mkdirSync(join(kultivDir, 'pending'), { recursive: true });
    mkdirSync(join(kultivDir, 'traces', 'runs'), { recursive: true });

    // Copy config template
    const configDest = join(kultivDir, 'config.yaml');
    if (!existsSync(configDest)) {
      const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'config.template.yaml');
      if (existsSync(templatePath)) {
        copyFileSync(templatePath, configDest);
      } else {
        // Inline fallback template
        const template = `version: "1.0"\nartifacts: {}\nllm:\n  provider: anthropic\n  model: claude-sonnet-4-20250514\n  auth_env: ANTHROPIC_API_KEY\nevolution:\n  budget_per_session: 10\n  feedback_interval: 3\n  outer_interval: 10\n  plateau_window: 5\nautomation:\n  hook_mode: false\n  daemon_mode: false\n  cooldown_minutes: 10\n  auto_commit: true\n  auto_push: false\n  max_regressions_before_pause: 3\nmeta_strategy_path: .kultiv/meta-strategy.md\n`;
        writeFileSync(configDest, template, 'utf-8');
      }
      console.log(green('Created .kultiv/config.yaml'));
    }

    // Copy meta-strategy template
    const strategyDest = join(kultivDir, 'meta-strategy.md');
    if (!existsSync(strategyDest)) {
      const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'meta-strategy.template.md');
      if (existsSync(templatePath)) {
        copyFileSync(templatePath, strategyDest);
      } else {
        writeFileSync(strategyDest, '# Mutation Strategy\n\n## Priority Order\n1. ADD_RULE\n2. ADD_EXAMPLE\n3. SIMPLIFY\n', 'utf-8');
      }
      console.log(green('Created .kultiv/meta-strategy.md'));
    }

    // Create empty archive
    const archivePath = join(kultivDir, 'archive.jsonl');
    if (!existsSync(archivePath)) {
      writeFileSync(archivePath, '', 'utf-8');
      console.log(green('Created .kultiv/archive.jsonl'));
    }

    console.log(green('\nKultiv initialized. Next steps:'));
    console.log(dim('  1. kultiv add <name> <path>    — register an artifact'));
    console.log(dim('  2. kultiv baseline              — score artifacts'));
    console.log(dim('  3. kultiv evolve                — start evolving'));
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
    console.log(dim('  Edit .kultiv/config.yaml to configure the scorer chain.'));
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

        // Create LLM provider if chain has llm-judge evaluators
        const hasLLMJudge = artifactConfig.scorer.chain.some(
          (item) => item.type === 'llm-judge'
        );
        const chainOptions: { provider?: ReturnType<typeof createProvider>; artifactContent?: string; artifactPath?: string } = {
          artifactPath: artifact.path,
          artifactContent: artifact.content,
        };
        if (hasLLMJudge) {
          try {
            chainOptions.provider = createProvider(config.llm);
          } catch (err) {
            console.log(dim(`  ⚠ LLM provider unavailable: ${String(err).slice(0, 80)}`));
          }
        }

        const scorecard = await runChain(artifactConfig.scorer.chain, resolve('.'), chainOptions);

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

// ── scan ────────────────────────────────────────────────────────────────

program
  .command('scan')
  .description('Analyze agent prompts for purpose, structure, and improvement opportunities')
  .option('-a, --artifact <id>', 'specific artifact to scan')
  .option('-f, --file <path>', 'scan any file directly (no config needed)')
  .action(async (opts, cmd) => {
    const { scanArtifact, saveScanAnalysis } = await import('../src/mutation/scan.js');

    if (opts.file) {
      // Scan a standalone file
      const filePath = resolve(opts.file);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        console.error(red(`File not found: ${filePath}`));
        process.exit(1);
      }
      const configPath = resolveConfigPath(cmd.optsWithGlobals());
      const config = loadConfig(configPath);
      const provider = createProvider(config.llm);
      const artifactId = opts.file.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-');

      console.log(`\nScanning ${bold(filePath)}...`);
      const analysis = await scanArtifact(content, artifactId, provider);
      printScanAnalysis(analysis);
      return;
    }

    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    const config = loadConfig(configPath);
    const provider = createProvider(config.llm);
    const kultivDir = resolveKultivDir();

    const artifactIds = opts.artifact
      ? [opts.artifact]
      : Object.keys(config.artifacts);

    for (const id of artifactIds) {
      const artifactConfig = config.artifacts[id];
      if (!artifactConfig) {
        console.error(red(`Artifact "${id}" not found in config`));
        continue;
      }

      const artifact = loadArtifact(id, artifactConfig);
      console.log(`\nScanning ${bold(id)}...`);

      try {
        const analysis = await scanArtifact(artifact.content, id, provider);
        saveScanAnalysis(kultivDir, analysis);
        printScanAnalysis(analysis);
        console.log(dim(`  Saved to .kultiv/scans/${id}.json`));
      } catch (err) {
        console.error(red(`  Error scanning ${id}: ${String(err)}`));
      }
    }
  });

function printScanAnalysis(analysis: { purpose: string; domain: string; sections: Array<{ name: string; lineCount: number; assessment: string }>; recommendations: Array<{ type: string; target: string; rationale: string; priority: string }>; hasExamples: boolean; hasNegativeExamples: boolean; hasDecisionTrees: boolean }): void {
  console.log(`  ${bold('Purpose:')} ${analysis.purpose}`);
  console.log(`  ${bold('Domain:')} ${analysis.domain}`);
  console.log(`  ${bold('Features:')} examples=${analysis.hasExamples ? green('yes') : red('no')} negative=${analysis.hasNegativeExamples ? green('yes') : red('no')} decision-trees=${analysis.hasDecisionTrees ? green('yes') : red('no')}`);

  if (analysis.sections.length > 0) {
    console.log(`\n  ${bold('Sections:')}`);
    for (const s of analysis.sections) {
      console.log(`    ${s.name} (${s.lineCount} lines) — ${s.assessment}`);
    }
  }

  if (analysis.recommendations.length > 0) {
    console.log(`\n  ${bold('Recommendations:')}`);
    for (const r of analysis.recommendations) {
      const color = r.priority === 'high' ? red : r.priority === 'medium' ? yellow : dim;
      console.log(`    ${color(`[${r.priority}]`)} ${bold(r.type)}: ${r.target}`);
      console.log(`      ${r.rationale}`);
    }
  }
}

// ── challenges ──────────────────────────────────────────────────────────

program
  .command('challenges')
  .description('Manage evaluation challenges for artifacts')
  .option('-a, --artifact <id>', 'specific artifact (required for generate)')
  .option('--generate', 'auto-generate challenges targeting weak criteria')
  .option('--list', 'list existing challenges')
  .action(async (opts, cmd) => {
    const configPath = resolveConfigPath(cmd.optsWithGlobals());
    const config = loadConfig(configPath);
    const kultivDir = resolveKultivDir();

    const artifactIds = opts.artifact
      ? [opts.artifact]
      : Object.keys(config.artifacts);

    if (opts.generate) {
      const { generateChallenges, saveChallenges } = await import('../src/challenges/generator.js');
      const { loadChallenges } = await import('../src/challenges/loader.js');
      const { loadScanAnalysis } = await import('../src/mutation/scan.js');
      const provider = createProvider(config.llm);

      for (const id of artifactIds) {
        const artifactConfig = config.artifacts[id];
        if (!artifactConfig) {
          console.error(red(`Artifact "${id}" not found in config`));
          continue;
        }

        const artifact = loadArtifact(id, artifactConfig);
        const challengesDir = resolve(kultivDir, 'challenges', id);

        // Load existing challenges
        let existing: Array<{ id: string; name: string; description: string; difficulty: number; tags?: string[] }> = [];
        try { existing = loadChallenges(challengesDir); } catch { /* none yet */ }

        // Load weak criteria from archive
        const archive = new (await import('../src/core/archive.js')).Archive(resolve(kultivDir, 'archive.jsonl'));
        const entries = archive.getByArtifact(id);
        const scored = entries.filter(e => e.score !== null);
        const latest = scored.length > 0 ? scored[scored.length - 1] : null;
        const weakCriteria = (latest?.scorecard_checks ?? [])
          .filter(c => c.max > 0 && c.score / c.max < 0.75);

        // Load scan analysis if available
        const scanAnalysis = loadScanAnalysis(kultivDir, id);

        console.log(`\nGenerating challenges for ${bold(id)}...`);
        if (weakCriteria.length > 0) {
          console.log(dim(`  Targeting weak criteria: ${weakCriteria.map(c => `${c.name} (${Math.round(c.score / c.max * 100)}%)`).join(', ')}`));
        }

        try {
          const newChallenges = await generateChallenges(
            artifact.content, scanAnalysis, weakCriteria, existing, provider,
          );
          saveChallenges(challengesDir, newChallenges);
          console.log(green(`  Generated ${newChallenges.length} challenges:`));
          for (const c of newChallenges) {
            console.log(`    ${bold(c.name)} (difficulty: ${c.difficulty}/10) — ${c.description}`);
          }
          console.log(dim(`  Saved to .kultiv/challenges/${id}/`));
        } catch (err) {
          console.error(red(`  Error generating challenges: ${String(err)}`));
        }
      }
    } else {
      // List mode (default)
      const { loadChallenges } = await import('../src/challenges/loader.js');

      for (const id of artifactIds) {
        const challengesDir = resolve(kultivDir, 'challenges', id);
        let challenges: Array<{ id: string; name: string; description: string; difficulty: number; tags?: string[] }> = [];
        try { challenges = loadChallenges(challengesDir); } catch { /* none */ }

        console.log(`\n${bold(id)}: ${challenges.length} challenge${challenges.length !== 1 ? 's' : ''}`);
        if (challenges.length === 0) {
          console.log(dim(`  No challenges yet. Run: kultiv challenges --generate --artifact ${id}`));
        }
        for (const c of challenges) {
          const tags = c.tags?.length ? ` [${c.tags.join(', ')}]` : '';
          console.log(`  ${c.name} (difficulty: ${c.difficulty}/10)${tags}`);
          console.log(dim(`    ${c.description}`));
        }
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
    console.log(bold('\nKultiv Status'));
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

    const kultivDir = resolveKultivDir();
    const artifactId = opts.artifact;
    const command = commandParts.join(' ');

    console.log(dim(`Tracing: ${command}`));
    const { runId } = initRun(kultivDir, artifactId, 'cli');

    try {
      execSync(command, { stdio: 'inherit' });
      finalizeRun(kultivDir, runId, 0, 0, { traced: true });
      console.log(green(`Trace ${runId} completed.`));
    } catch (err) {
      finalizeRun(kultivDir, runId, 0, 0, { traced: true, error: String(err) });
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
    const kultivDir = resolveKultivDir();

    const existingPid = readDaemonPid(kultivDir);
    if (existingPid !== null) {
      console.log(yellow(`Daemon may already be running (PID: ${existingPid})`));
      console.log(dim('Use `kultiv daemon stop` to stop it first.'));
      return;
    }

    await startDaemon(config, kultivDir);
  });

daemonCmd
  .command('stop')
  .description('Stop the automation daemon')
  .action(() => {
    const kultivDir = resolveKultivDir();
    const pid = readDaemonPid(kultivDir);

    if (pid === null) {
      console.log(dim('No daemon running.'));
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(green(`Sent SIGTERM to daemon (PID: ${pid})`));
    } catch {
      console.log(yellow(`Could not signal PID ${pid} — cleaning up stale PID file.`));
      const pidFile = join(kultivDir, 'daemon.pid');
      if (existsSync(pidFile)) unlinkSync(pidFile);
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

// ── Pause Command ──────────────────────────────────────────────────────

program
  .command('pause')
  .description('Pause the current evolution session')
  .action(() => {
    const kultivDir = resolve('.kultiv');
    const signalPath = join(kultivDir, 'pause-signal');
    writeFileSync(signalPath, new Date().toISOString(), 'utf-8');
    console.log(yellow('Pause signal sent. Current experiment will finish, then session pauses.'));
    console.log(dim('Run `kultiv resume` to continue.'));
  });

// ── Resume Command ─────────────────────────────────────────────────────

program
  .command('resume')
  .description('Resume a paused evolution session')
  .option('-n, --budget <n>', 'Remaining budget (default: resume with original)')
  .action(async (opts) => {
    const kultivDir = resolve('.kultiv');
    const sessionPath = join(kultivDir, 'session-state.json');
    const signalPath = join(kultivDir, 'pause-signal');

    // Clear pause signal
    if (existsSync(signalPath)) {
      unlinkSync(signalPath);
    }

    if (!existsSync(sessionPath)) {
      console.log(yellow('No paused session found.'));
      return;
    }

    try {
      const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
        status: string;
        total_budget: number;
        current_experiment: number;
        options?: { artifactId?: string; safe?: boolean };
      };

      if (session.status !== 'paused') {
        console.log(yellow(`Session is ${session.status}, not paused.`));
        return;
      }

      const remaining = opts.budget
        ? parseInt(opts.budget, 10)
        : session.total_budget - session.current_experiment;

      console.log(green(`Resuming session — ${remaining} experiments remaining`));

      const config = loadConfig(resolveConfigPath({}));
      const result = await evolve(config, {
        budget: remaining,
        artifactId: session.options?.artifactId,
        safe: session.options?.safe,
      });

      console.log(bold('\nSession Complete'));
      console.log(`  Experiments: ${result.experiments.length}`);
      console.log(`  Successes: ${green(String(result.experiments.filter(e => e.status === 'success').length))}`);
      console.log(`  Regressions: ${red(String(result.experiments.filter(e => e.status === 'regression').length))}`);
    } catch (err) {
      console.log(red(`Resume failed: ${String(err)}`));
    }
  });

// ── Dashboard Command ──────────────────────────────────────────────────

program
  .command('dashboard')
  .description('Open the Kultiv web dashboard')
  .option('-p, --port <port>', 'Port number', '4200')
  .option('--kultiv-dir <path>', 'Path to .kultiv directory', '.kultiv')
  .action(async (opts) => {
    const { startDashboard } = await import('../src/dashboard/server.js');
    const kultivDir = resolve(opts.kultivDir ?? '.kultiv');
    const configPath = join(kultivDir, 'config.yaml');
    let config: EvoConfig;
    try {
      config = loadConfig(configPath);
    } catch {
      // Not initialized — start dashboard anyway with defaults
      config = {
        version: '1.0',
        artifacts: {},
        llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        evolution: { budget_per_session: 10, feedback_interval: 3, outer_interval: 10, plateau_window: 5, mutation_mode: 'dialogue' as const, beam_width: 3, cross_validation_count: 2, selection: { parent_method: 'tournament' as const, parent_temperature: 2.0, challenge_method: 'curriculum' as const } },
        feedback: { deterministic_interval: 3, llm_reflection_interval: 6, llm_reflection_enabled: true },
        outer_loop: { mode: 'dialogue' as const, validation_batch_size: 3 },
        automation: { hook_mode: false, daemon_mode: false, trigger_after: 1, cooldown_minutes: 10, auto_commit: true, auto_push: false, max_regressions_before_pause: 3 },
        dashboard: { port: 4200, open_browser: true },
        dreaming: {
          enabled: false,
          max_sessions: 20,
          within_days: 14,
          cooldown_hours: 6,
          auto_apply: false,
          input_cost_per_mtok: 3,
          output_cost_per_mtok: 15,
        },
        meta_strategy_path: '.kultiv/meta-strategy.md',
      };
    }
    const port = parseInt(opts.port, 10);
    const openBrowser = opts.kultivDir ? false : config.dashboard.open_browser;
    await startDashboard(port, kultivDir, openBrowser);
  });

// ── Dream Commands ──────────────────────────────────────────────────────

import { runDream, applyDream, rejectDream } from '../src/dreaming/dreamer.js';
import { DreamHistory } from '../src/dreaming/history.js';

const dreamCmd = program.command('dream').description('Memory consolidation across past sessions');

dreamCmd
  .command('run', { isDefault: true })
  .description('Run a dream now — produces proposed memory + patterns for review')
  .option('--force', 'Bypass cooldown')
  .option('--auto-apply', 'Apply the dream output to live memory if it succeeds')
  .option('--instructions <text>', 'Per-run focus instructions appended to the prompt')
  .option('--memory-dir <path>', 'Override memory tier path')
  .option('--sessions-dir <path>', 'Override Claude Code sessions path')
  .option('--max-sessions <n>', 'Max sessions to consume', (v) => parseInt(v, 10))
  .option('--within-days <n>', 'Lookback window', (v) => parseInt(v, 10))
  .option('--kultiv-dir <path>', 'Path to .kultiv directory', '.kultiv')
  .action(async (opts) => {
    const configPath = resolveConfigPath({ config: program.opts<{ config?: string }>().config });
    const config = loadConfig(configPath);
    const kultivDir = resolve(opts.kultivDir ?? '.kultiv');

    const memoryDir = resolve(opts.memoryDir ?? config.dreaming.memory_dir ?? defaultMemoryDir());
    const sessionsDir = resolve(opts.sessionsDir ?? config.dreaming.sessions_dir ?? defaultSessionsDir());
    const archivePath = join(kultivDir, 'archive.jsonl');

    const llmConfig = config.dreaming.model
      ? { ...config.llm, model: config.dreaming.model }
      : config.llm;
    const provider = createProvider(llmConfig);

    console.log(bold('Kultiv Dream'));
    console.log(dim(`  Memory:  ${memoryDir}`));
    console.log(dim(`  Sessions:${sessionsDir}`));
    console.log(dim(`  Model:   ${llmConfig.model}`));
    console.log('');

    const out = await runDream(
      {
        evoDir: kultivDir,
        memoryDir,
        sessionsDir,
        archivePath,
        provider,
        modelId: llmConfig.model,
        inputCostPerMTok: config.dreaming.input_cost_per_mtok,
        outputCostPerMTok: config.dreaming.output_cost_per_mtok,
        maxSessions: opts.maxSessions ?? config.dreaming.max_sessions,
        withinDays: opts.withinDays ?? config.dreaming.within_days,
        instructions: opts.instructions ?? config.dreaming.instructions,
      },
      {
        force: opts.force === true,
        autoApply: opts.autoApply === true || config.dreaming.auto_apply,
        cooldownHours: config.dreaming.cooldown_hours,
      },
    );

    if (out.skipped) {
      console.log(yellow(`Skipped: ${out.skipped}${out.result.error ? ` — ${out.result.error}` : ''}`));
      return;
    }

    if (out.result.status === 'failed') {
      console.log(red(`Dream FAILED: ${out.result.error ?? 'unknown error'}`));
      if (out.result.summaryPath) console.log(dim(`  details: ${out.result.summaryPath}`));
      process.exitCode = 1;
      return;
    }

    console.log(green('Dream completed.'));
    console.log(dim(`  id:        ${out.result.id}`));
    console.log(dim(`  patterns:  ${out.result.patterns.length}`));
    console.log(dim(`  tokens:    in=${out.result.inputTokens}, out=${out.result.outputTokens}`));
    console.log(dim(`  cost:      $${out.result.estimatedCostUsd.toFixed(4)}`));
    if (out.applied) {
      console.log(green('  applied:   yes (live memory updated)'));
    } else {
      console.log(dim(`  proposal:  ${out.result.summaryPath ?? out.result.proposedMemoryPath}`));
      console.log(dim(`  apply:     kultiv dream apply ${out.result.id}`));
    }
  });

dreamCmd
  .command('list')
  .description('Show recent dreams')
  .option('--kultiv-dir <path>', 'Path to .kultiv directory', '.kultiv')
  .option('-n, --limit <n>', 'Max entries', (v) => parseInt(v, 10), 20)
  .action((opts) => {
    const kultivDir = resolve(opts.kultivDir ?? '.kultiv');
    const history = new DreamHistory(join(kultivDir, 'dreams', 'history.jsonl'));
    const entries = history.list(opts.limit);
    if (entries.length === 0) {
      console.log(dim('(no dreams yet)'));
      return;
    }
    for (const e of entries) {
      const status = e.status === 'completed' ? green(e.status) : e.status === 'failed' ? red(e.status) : yellow(e.status);
      const applied = e.applied ? green('applied') : dim('proposed');
      console.log(`${e.id}  ${status}  ${applied}  patterns=${e.patternCount}  cost=$${e.estimatedCostUsd.toFixed(4)}`);
    }
  });

dreamCmd
  .command('apply <id>')
  .description('Apply a previously-proposed dream to live memory')
  .option('--memory-dir <path>', 'Override memory tier path')
  .option('--kultiv-dir <path>', 'Path to .kultiv directory', '.kultiv')
  .action((id, opts) => {
    const kultivDir = resolve(opts.kultivDir ?? '.kultiv');
    const proposalDir = join(kultivDir, 'dreams', 'proposed', id);
    const proposedMemory = join(proposalDir, 'MEMORY.md');
    if (!existsSync(proposedMemory)) {
      console.log(red(`No proposal found at ${proposalDir}`));
      process.exitCode = 1;
      return;
    }
    const memoryDir = resolve(opts.memoryDir ?? defaultMemoryDir());
    const written = applyDream(
      { memoryDir, evoDir: kultivDir },
      // Reconstruct minimal DreamResult — only proposedMemoryPath is required for apply.
      {
        id,
        status: 'completed',
        startedAt: '',
        completedAt: null,
        model: '',
        inputSessionIds: [],
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        proposedMemoryPath: proposedMemory,
        proposedPatternsPath: null,
        summaryPath: null,
        patterns: [],
      },
    );
    new DreamHistory(join(kultivDir, 'dreams', 'history.jsonl')).markApplied(id, new Date().toISOString());
    console.log(green(`Applied dream ${id} — ${written.length} files updated.`));
  });

dreamCmd
  .command('reject <id>')
  .description('Reject a previously-proposed dream (moves it to rejected/)')
  .option('--kultiv-dir <path>', 'Path to .kultiv directory', '.kultiv')
  .action((id, opts) => {
    const kultivDir = resolve(opts.kultivDir ?? '.kultiv');
    const proposalDir = join(kultivDir, 'dreams', 'proposed', id);
    const proposedMemory = join(proposalDir, 'MEMORY.md');
    if (!existsSync(proposedMemory)) {
      console.log(red(`No proposal found at ${proposalDir}`));
      process.exitCode = 1;
      return;
    }
    const target = rejectDream(
      { evoDir: kultivDir },
      {
        id,
        status: 'completed',
        startedAt: '',
        completedAt: null,
        model: '',
        inputSessionIds: [],
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        proposedMemoryPath: proposedMemory,
        proposedPatternsPath: null,
        summaryPath: null,
        patterns: [],
      },
    );
    console.log(green(`Rejected dream ${id} — moved to ${target}`));
  });

dreamCmd
  .command('patterns')
  .description('Print the active dream patterns the mutation engine consumes')
  .option('--kultiv-dir <path>', 'Path to .kultiv directory', '.kultiv')
  .action((opts) => {
    const kultivDir = resolve(opts.kultivDir ?? '.kultiv');
    const path = join(kultivDir, 'dreams', 'patterns.md');
    if (!existsSync(path)) {
      console.log(dim('(no patterns yet — run `kultiv dream` first)'));
      return;
    }
    process.stdout.write(readFileSync(path, 'utf-8'));
  });

function defaultMemoryDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  // The default targets Claude Code's per-project memory dir for the CWD.
  // Users who want a different location should set dreaming.memory_dir.
  const projectSlug = process.cwd()
    .replace(/[/\\]/g, '-')
    .replace(/[^A-Za-z0-9.-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return join(home, '.claude', 'projects', projectSlug, 'memory');
}

function defaultSessionsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
  const projectSlug = process.cwd()
    .replace(/[/\\]/g, '-')
    .replace(/[^A-Za-z0-9.-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return join(home, '.claude', 'projects', projectSlug);
}

// ── Parse ───────────────────────────────────────────────────────────────

program.parse();
