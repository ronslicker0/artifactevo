# ArtifactEvo

> Automated artifact evolution -- evolve prompts, configs, templates, and code through trace-driven mutation loops.

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)
![Node](https://img.shields.io/badge/Node.js-20%2B-green?logo=node.js)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

**Lineage:** ArtifactEvo unifies [PromptEvo](https://github.com/ronslicker0/promptevo) (evolution engine) and [Meta-Harness](https://github.com/ronslicker0/meta-harness) (trace-based orchestration) into a single system. Key improvements over PromptEvo: single-call structured mutations (65-75% cheaper), deterministic anti-pattern detection (zero LLM tokens), hook-triggered + cron automation, and a built-in Preact dashboard.

![ArtifactEvo Dashboard](docs/screenshots/dashboard-example.png)

## What It Does

ArtifactEvo takes any text artifact -- a prompt, config file, template, or documentation -- scores it against a chain of evaluators (TypeScript compiler, test suites, linters, LLM judges), proposes targeted mutations via a single structured LLM call, keeps improvements, and reverts regressions. It uses bilevel evolution: an inner loop mutates and scores artifacts, while an outer loop evolves the mutation strategy itself based on global statistics. By using single structured LLM calls instead of multi-round conversations, ArtifactEvo achieves 65-75% lower token costs than comparable approaches.

## Quick Start

```bash
npm install -g artifactevo   # or use npx artifactevo
cd your-project
evo init                      # create .evo/ directory with config
evo add my-prompt ./agents/my-prompt.md
evo baseline                  # score current artifact
evo evolve -n 10              # run 10 mutation experiments
evo status                    # view scores and anti-patterns
```

## Installation

**Prerequisites**: Node.js 20+, npm 9+

```bash
# Global install
npm install -g artifactevo

# Or run without installing
npx artifactevo init

# Or clone and build from source
git clone https://github.com/ronslicker0/artifactevo.git
cd artifactevo
npm install
npm run build
npm link
```

## Features

- **9 mutation types** -- ADD_RULE, ADD_EXAMPLE, ADD_NEGATIVE_EXAMPLE, REORDER, SIMPLIFY, REPHRASE, DELETE_RULE, MERGE_RULES, RESTRUCTURE
- **Deterministic-first scoring** -- command evaluators (tsc, npm test, lint) consume zero tokens; LLM-judge is optional and weighted
- **Heuristic anti-pattern detection** -- type fixation, plateau, saturation, overfitting, and bloat detection using pure arithmetic on archive data
- **Bilevel evolution** -- inner loop mutates and scores artifacts; outer loop revises the mutation strategy based on global statistics
- **Dual automation** -- hook-triggered evolution (Claude Code post-session) and cron daemon with lockfile deduplication
- **JSONL archive** -- every experiment logged with full lineage (parent, diff, score, token cost, status)
- **Git safety** -- branch-per-experiment with auto-merge on success and auto-abandon on regression
- **Web dashboard** -- terminal status view and web UI at localhost:4200
- **Multiple LLM providers** -- Anthropic, OpenAI, Ollama (local), Claude Code CLI

## Configuration

ArtifactEvo stores all state in a `.evo/` directory at your project root. The main config file is `.evo/config.yaml`.

### Full Config Reference

```yaml
version: "1.0"

# ── Artifacts ──────────────────────────────────────────────────────────
# Each artifact is a text file you want to evolve.
# Register artifacts with `evo add <name> <path>` or edit this directly.
artifacts:
  my-prompt:
    path: ./agents/my-prompt.md          # relative path to the artifact file
    type: prompt                          # prompt | config | template | doc
    scorer:
      chain:
        - name: typecheck                 # human-readable evaluator name
          command: "npx tsc --noEmit"     # shell command to run
          type: script                    # script | pattern | llm-judge
          weight: 3                       # relative weight in composite score
        - name: tests
          command: "npx vitest run"
          type: script
          weight: 2
        - name: quality
          type: llm-judge                 # uses the configured LLM provider
          rules_file: .evo/judge-rules.md # optional rubric for the judge
          weight: 1
    challenges_dir: .evo/challenges/      # optional directory of test scenarios

# ── LLM ────────────────────────────────────────────────────────────────
# Provider used for mutations and optional LLM-judge scoring.
llm:
  provider: anthropic                     # anthropic | openai | claude-code
  model: claude-sonnet-4-20250514         # model identifier
  auth_env: ANTHROPIC_API_KEY             # env var holding the API key

# ── Evolution ──────────────────────────────────────────────────────────
# Controls the mutation loop behavior.
evolution:
  budget_per_session: 10                  # max mutations per evo session
  feedback_interval: 3                    # anti-pattern check every N runs
  outer_interval: 10                      # meta-strategy revision every N runs
  plateau_window: 5                       # score window for plateau detection

# ── Automation ─────────────────────────────────────────────────────────
# Controls unattended evolution (hooks and daemon).
automation:
  hook_mode: false                        # trigger evolution from Claude Code hooks
  daemon_mode: false                      # run background daemon on schedule
  daemon_schedule: "*/30 * * * *"         # cron expression for daemon
  trigger_after: 1                        # evolve after every N new traced runs
  cooldown_minutes: 10                    # minimum gap between auto-sessions
  auto_commit: true                       # git commit improved artifacts
  auto_push: false                        # require manual push (safety default)
  max_regressions_before_pause: 3         # pause automation after N regressions

# ── Dashboard ──────────────────────────────────────────────────────────
dashboard:
  port: 4200                              # web dashboard port
  open_browser: true                      # auto-open browser on launch

# ── Meta-Strategy ──────────────────────────────────────────────────────
# Path to the self-improving mutation strategy document.
# The outer loop rewrites this file based on global statistics.
meta_strategy_path: .evo/meta-strategy.md
```

### Config Field Summary

| Section | Field | Type | Default | Description |
|---------|-------|------|---------|-------------|
| `artifacts.<name>` | `path` | `string` | -- | Path to the artifact file |
| `artifacts.<name>` | `type` | `enum` | -- | `prompt`, `config`, `template`, or `doc` |
| `artifacts.<name>` | `scorer.chain[]` | `array` | -- | Ordered list of evaluators |
| `llm` | `provider` | `enum` | -- | `anthropic`, `openai`, or `claude-code` |
| `llm` | `model` | `string` | -- | Model identifier for the provider |
| `llm` | `auth_env` | `string` | -- | Environment variable holding the API key |
| `evolution` | `budget_per_session` | `number` | `10` | Max mutations per session |
| `evolution` | `feedback_interval` | `number` | `3` | Anti-pattern check frequency |
| `evolution` | `outer_interval` | `number` | `10` | Meta-strategy revision frequency |
| `evolution` | `plateau_window` | `number` | `5` | Window size for plateau detection |
| `automation` | `hook_mode` | `boolean` | `false` | Enable hook-triggered evolution |
| `automation` | `daemon_mode` | `boolean` | `false` | Enable background daemon |
| `automation` | `cooldown_minutes` | `number` | `10` | Minimum gap between auto-sessions |
| `automation` | `auto_commit` | `boolean` | `true` | Auto-commit improved artifacts |
| `automation` | `auto_push` | `boolean` | `false` | Auto-push commits to remote |
| `automation` | `max_regressions_before_pause` | `number` | `3` | Regression limit before auto-pause |
| `dashboard` | `port` | `number` | `4200` | Web dashboard port |

## CLI Reference

All commands accept a global `-c, --config <path>` option to specify the config file (defaults to `.evo/config.yaml`).

### evo init

Initialize a new `.evo/` directory with default config, meta-strategy, and empty archive.

```bash
evo init
evo init --preset nextjs
```

**Options:**

| Flag | Description |
|------|-------------|
| `--preset <type>` | Preset configuration (default: `standard`) |

**What it creates:**

```
.evo/
  config.yaml         # main config
  meta-strategy.md    # mutation strategy (self-improving)
  archive.jsonl       # experiment log (empty)
  pending/            # queue for hook-triggered runs
  traces/runs/        # traced command output
```

### evo add

Register an artifact in the config file.

```bash
evo add my-prompt ./agents/my-prompt.md
evo add app-config ./config/settings.yaml
```

This adds the artifact to `.evo/config.yaml` with a placeholder scorer chain. Edit the config to set up real evaluators.

### evo baseline

Score all artifacts (or a specific one) without mutations. Records the baseline in the archive.

```bash
evo baseline                    # baseline all artifacts
evo baseline -a my-prompt       # baseline a specific artifact
```

**Options:**

| Flag | Description |
|------|-------------|
| `-a, --artifact <id>` | Baseline a specific artifact only |

**Example output:**

```
Scoring my-prompt...
  my-prompt: 72/100 (72%)
    PASS typecheck: 30/30
    FAIL tests: 22/40
    PASS quality: 20/30
```

### evo run

Execute a single mutation experiment. Proposes one mutation, scores the result, and either keeps or reverts the change.

```bash
evo run                         # evolve first artifact
evo run -a my-prompt            # evolve a specific artifact
evo run --dry-run               # propose without applying
evo run --safe                  # also revert neutral mutations
```

**Options:**

| Flag | Description |
|------|-------------|
| `-a, --artifact <id>` | Target artifact |
| `--dry-run` | Show proposed mutation without applying it |
| `--safe` | Revert neutral mutations (not just regressions) |

### evo evolve

Run a full evolution session -- multiple mutation experiments with anti-pattern detection and optional meta-strategy revision.

```bash
evo evolve                      # use budget from config
evo evolve -n 20                # run 20 experiments
evo evolve -a my-prompt --safe  # evolve specific artifact, safe mode
```

**Options:**

| Flag | Description |
|------|-------------|
| `-n, --budget <number>` | Override `budget_per_session` from config |
| `-a, --artifact <id>` | Target a specific artifact |
| `--safe` | Revert neutral mutations |

### evo status

Display a summary of all artifacts, scores, mutation counts, and detected anti-patterns.

```bash
evo status
evo status -a my-prompt
```

**Example output:**

```
ArtifactEvo Status
=======================================================
Artifacts: 2 registered
Archive:   47 experiments (31 success, 8 regression, 8 neutral)
Tokens:    ~24,500 total

+------------------+-------+-----+----------+--------------+
| Artifact         | Score | Max | Mutations| Last Type    |
+------------------+-------+-----+----------+--------------+
| my-prompt        | 89    | 100 | 35       | ADD_EXAMPLE  |
| app-config       | 74    | 100 | 12       | SIMPLIFY     |
+------------------+-------+-----+----------+--------------+

Anti-patterns: 1 warning(s)
  !! plateau on my-prompt: Score unchanged for 5 consecutive runs
```

### evo history

Show the archive history, most recent first.

```bash
evo history                     # last 20 entries
evo history -n 50               # last 50 entries
evo history -a my-prompt        # filter by artifact
```

**Options:**

| Flag | Description |
|------|-------------|
| `-a, --artifact <id>` | Filter entries by artifact |
| `-n, --count <number>` | Number of entries to show (default: 20) |

### evo trace

Wrap a shell command as a traced run. The trace is recorded in `.evo/traces/` and can trigger hook-based evolution.

```bash
evo trace "npm test" -a my-prompt
evo trace "npx tsc --noEmit" -a app-config
```

**Options:**

| Flag | Description |
|------|-------------|
| `--artifact <id>` | **(required)** Artifact to associate with the trace |

### evo daemon start / stop

Manage the background automation daemon.

```bash
evo daemon start                # start the daemon
evo daemon stop                 # stop the daemon
```

The daemon runs on the schedule defined in `automation.daemon_schedule` (cron expression). It checks for pending traced runs, respects the cooldown timer, and pauses after hitting the regression limit.

## Scoring System

ArtifactEvo uses a composite scoring chain. Each evaluator in the chain runs independently and contributes a weighted score to the total.

### Evaluator Types

**Command scorers** (`type: script`) run a shell command and derive a score from the exit code and output. These are deterministic, reproducible, and consume zero LLM tokens.

```yaml
- name: typecheck
  command: "npx tsc --noEmit"
  type: script
  weight: 3
```

**Pattern scorers** (`type: pattern`) apply regex rules against the artifact content. Useful for enforcing structural constraints (e.g., "must contain a ## Examples section").

```yaml
- name: structure
  type: pattern
  rules_file: .evo/pattern-rules.yaml
  weight: 1
```

**LLM-judge scorers** (`type: llm-judge`) send the artifact to the configured LLM with a scoring rubric. These provide nuanced quality assessment but consume tokens.

```yaml
- name: quality
  type: llm-judge
  rules_file: .evo/judge-rubric.md
  weight: 1
```

### Composite Score

The total score is computed as a weighted sum across all evaluators:

```
total = sum(evaluator_score * weight) / sum(max_evaluator_score * weight) * 100
```

You control the balance between deterministic and LLM-based scoring by adjusting the weights. For cost-sensitive setups, use only command and pattern scorers (zero tokens). Add an LLM-judge only when you need subjective quality assessment.

## Mutation Types

ArtifactEvo uses 9 mutation types, selected based on the current meta-strategy and recent archive history.

| Type | Action | When to Use | Example |
|------|--------|-------------|---------|
| `ADD_RULE` | Add a new behavioral rule | Evaluator failed due to missing behavior | Add "Always validate input with Zod" |
| `ADD_EXAMPLE` | Add a positive example | Rule exists but is misapplied | Add a code snippet showing correct usage |
| `ADD_NEGATIVE_EXAMPLE` | Add a "do not do this" example | Same error repeats 3+ times | Add "Do NOT use `any` type" with bad example |
| `REORDER` | Move a section up or down | Important rule is buried below line 50 | Move auth instructions to top of prompt |
| `SIMPLIFY` | Remove redundant content | Artifact > 200 lines with low improvement | Consolidate 3 similar rules into 1 |
| `REPHRASE` | Rewrite for clarity | Evaluator scores fluctuate on same content | Change ambiguous "handle errors" to specific instruction |
| `DELETE_RULE` | Remove a rule entirely | Rule consistently causes regressions | Remove over-specific formatting rule |
| `MERGE_RULES` | Combine related rules | Multiple scattered rules cover same topic | Merge 4 auth-related rules into one section |
| `RESTRUCTURE` | Reorganize the artifact | Related content is far apart | Group all API rules under one heading |

### Mutation Selection

The meta-strategy document (`.evo/meta-strategy.md`) defines the priority order. The selection algorithm:

1. Reads the current meta-strategy priority list
2. Filters out mutation types that failed recently (< 20% success rate over last 10 runs)
3. Avoids repeating the same type consecutively on the same artifact
4. After 3 consecutive ADD_* mutations, forces a structural mutation

The outer loop periodically rewrites the meta-strategy based on observed success rates across all artifacts.

## Architecture

```
src/
  core/           config loader, archive (JSONL), artifact reader, trace store
  scoring/        chain runner, command scorer, pattern scorer, LLM judge
  mutation/       single-call LLM engine, apply/revert, type selection
  detection/      plateau detection, anti-pattern heuristics (zero LLM tokens)
  loops/          inner loop (mutate/score), outer loop (meta-strategy), evolve orchestrator
  automation/     cron daemon, hook trigger, pending queue, lockfile
  llm/            provider interface + Anthropic, OpenAI, Ollama, Claude Code adapters
  safety/         git branch-per-experiment, auto-merge, auto-abandon

bin/
  evo.ts          CLI entry point (Commander.js)

templates/
  config.template.yaml       default config
  meta-strategy.template.md  default mutation strategy
```

### Data Flow

```
Artifact file  -->  Score (evaluator chain)  -->  Archive baseline
       |
       v
LLM mutation call  -->  Apply diff  -->  Re-score  -->  Compare
       |                                                    |
       v                                                    v
  Keep (success)                                  Revert (regression)
       |
       v
  Archive entry (JSONL)  -->  Anti-pattern detection  -->  Meta-strategy revision
```

### Archive Format

Each experiment is one JSON line in `.evo/archive.jsonl`:

```json
{
  "genid": 12,
  "artifact": "my-prompt",
  "parent": 11,
  "score": 85,
  "max_score": 100,
  "challenge": null,
  "run_id": null,
  "diff": "@@ -15,3 +15,5 @@\n+- Always validate with Zod\n+- Never use `any`",
  "mutation_type": "ADD_RULE",
  "mutation_desc": "Added input validation rules based on failing typecheck",
  "status": "success",
  "timestamp": "2026-03-31T14:22:00.000Z",
  "token_cost": 1847,
  "automated": false
}
```

Status values: `baseline`, `success`, `regression`, `neutral`, `crash`.

## LLM Providers

### Anthropic

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  auth_env: ANTHROPIC_API_KEY
```

Set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### OpenAI

```yaml
llm:
  provider: openai
  model: gpt-4o
  auth_env: OPENAI_API_KEY
```

```bash
export OPENAI_API_KEY=sk-...
```

### Ollama (Local)

```yaml
llm:
  provider: ollama
  model: llama3
```

No API key required. Ollama must be running locally on the default port (11434).

```bash
ollama serve   # start Ollama
ollama pull llama3
```

### Claude Code CLI

```yaml
llm:
  provider: claude-code
  model: claude-sonnet-4-20250514
```

Uses your existing Claude Code subscription. No separate API key needed.

## Automation

ArtifactEvo supports two modes of unattended evolution.

### Hook-Triggered Mode

When `automation.hook_mode` is enabled, ArtifactEvo integrates with Claude Code post-session hooks. After each coding session, the hook writes a pending file to `.evo/pending/`. On the next `evo evolve` or daemon tick, pending items are picked up and processed.

```yaml
automation:
  hook_mode: true
  trigger_after: 1        # evolve after every traced run
  cooldown_minutes: 10    # wait at least 10 minutes between sessions
```

### Cron Daemon Mode

The daemon runs in the background on a cron schedule. It checks for pending work, runs evolution sessions, and respects the cooldown and regression limits.

```yaml
automation:
  daemon_mode: true
  daemon_schedule: "*/30 * * * *"   # every 30 minutes
  auto_commit: true
  auto_push: false
  max_regressions_before_pause: 3
```

Start and stop the daemon:

```bash
evo daemon start
evo daemon stop
```

The daemon writes its PID to `.evo/daemon.pid` and uses a lockfile (`.evo/lock`) to prevent concurrent sessions.

### Safety Controls

- **Cooldown timer** prevents evolution from running too frequently
- **Regression limit** pauses automation after N consecutive regressions
- **Lockfile deduplication** prevents overlapping evolution sessions
- **auto_push defaults to false** so you always review changes before pushing

## Anti-Pattern Detection

ArtifactEvo runs heuristic checks on the archive data to detect unhealthy evolution patterns. These checks use pure arithmetic on archive entries and consume zero LLM tokens.

| Pattern | What It Means | Suggestion |
|---------|---------------|------------|
| **Type Fixation** | Same mutation type selected repeatedly | Diversify mutation types; the meta-strategy may be too narrow |
| **Plateau** | Score unchanged for N consecutive runs | Try structural mutations (RESTRUCTURE, SIMPLIFY) or revise the evaluator chain |
| **Saturation** | Score near maximum with diminishing returns | Consider adding harder evaluators or a new scoring dimension |
| **Overfitting** | Score improves on one evaluator but regresses on others | Rebalance evaluator weights or add cross-validation challenges |
| **Bloat** | Artifact size growing without proportional score improvement | Run SIMPLIFY or DELETE_RULE mutations |

View detected anti-patterns with `evo status`.

## Presets

Use presets with `evo init --preset <name>` to start with a config tailored to your project type.

| Preset | Evaluators Included | Best For |
|--------|-------------------|----------|
| `standard` | Generic placeholder scorer | Any project (default) |
| `nextjs` | tsc, eslint, next build | Next.js applications |
| `typescript` | tsc, eslint, vitest | TypeScript libraries |
| `python` | mypy, pytest, ruff | Python projects |
| `go` | go vet, go test, golangci-lint | Go projects |
| `rust` | cargo check, cargo test, clippy | Rust projects |

## Project Structure

After initialization, your project will contain:

```
your-project/
  .evo/
    config.yaml          # main configuration
    meta-strategy.md     # mutation strategy (evolves over time)
    archive.jsonl        # full experiment history
    pending/             # hook-triggered pending queue
    traces/
      runs/              # traced command output
    daemon.pid           # daemon process ID (when running)
    lock                 # lockfile for session deduplication
  agents/
    my-prompt.md         # your artifact (example)
```

All `.evo/` files are safe to commit to version control. The archive provides full lineage tracking, and the meta-strategy document shows how the system learned to improve your artifacts.

## Contributing

Contributions are welcome. To get started:

```bash
git clone https://github.com/ronslicker0/artifactevo.git
cd artifactevo
npm install
npm run build
npm test
```

**Development workflow:**

1. Create a branch for your feature or fix
2. Write tests for new functionality (`vitest`)
3. Ensure `npm run build && npm run lint && npm test` passes
4. Submit a pull request with a clear description of the change

**Key areas for contribution:**

- New LLM provider adapters (`src/llm/`)
- Additional mutation types (`src/mutation/types.ts`)
- New evaluator types (`src/scoring/`)
- Presets for more languages and frameworks
- Dashboard improvements

## License

MIT -- see [LICENSE](LICENSE) for details.
