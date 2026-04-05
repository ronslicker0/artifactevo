# Kultiv -- Cultivate Your Agents

> Your AI agents follow instructions. Kultiv rewrites those instructions,
> tests which version is better, and keeps the winners.
> Run it overnight. Wake up to smarter agents.

**Tweak -> Test -> Keep the best -> Repeat**

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)
![Node](https://img.shields.io/badge/Node.js-20%2B-green?logo=node.js)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

![Kultiv Dashboard](docs/screenshots/dashboard-example.png)

## What is Kultiv?

Kultiv is an open-source CLI tool that uses genetic algorithms to improve AI agent instructions automatically. Give it a prompt, tell it how to score quality, and it will tweak, test, and keep the best versions -- no manual editing required.

## Why Kultiv?

- **Manual prompt tuning doesn't scale.** You have 5 agents, each with 200-line instructions. Editing them by hand is slow and error-prone.
- **Small changes compound.** A 2% improvement per generation adds up. After 30 experiments, your agent prompt can go from 34% to 91%.
- **Your scoring criteria, not ours.** Use your own test suites, linters, or LLM judges. Kultiv scores against what matters to you.

## Get Started in 60 Seconds

```bash
npm install -g kultiv
cd your-project
kultiv init                       # creates .kultiv/ with config
kultiv add my-agent ./agents/my-agent.md
kultiv baseline                   # score the current version
kultiv evolve -n 10               # run 10 improvement experiments
```

## What Overnight Evolution Looks Like

**Before:**

```
my-agent: 34/100 (34%)
  FAIL typecheck: 10/30
  FAIL tests: 14/40
  PASS quality: 10/30
```

**After 30 experiments:**

```
my-agent: 91/100 (91%)
  PASS typecheck: 30/30
  PASS tests: 35/40
  PASS quality: 26/30
```

```
[##########---------] 15/30 experiments  |  12 kept  |  2 reverted  |  1 stuck
```

## How Kultiv Thinks

1. **Score** your artifact against a chain of tests (compiler, test suite, linter, LLM judge)
2. **Mutate** one thing using a single LLM call (add a rule, simplify, reorder, rephrase...)
3. **Re-score** the mutated version with the same tests
4. **Keep or revert** -- better score? Keep. Worse? Revert automatically
5. **Learn** -- after every few experiments, Kultiv revises its own mutation strategy based on what worked

## Features

- **9 mutation types** -- add rules, add examples, simplify, reorder, rephrase, merge, restructure, delete, add negative examples
- **Tests that cost nothing** -- run your existing test suites, linters, and compilers as scorers. Zero LLM tokens for deterministic checks
- **Knows when it's stuck** -- detects plateaus, type fixation, overfitting, and bloat using pure math on your experiment history
- **Improves how it improves** -- a second evolution loop rewrites the mutation strategy based on what's actually working
- **Runs while you sleep** -- hook into Claude Code post-session events or run a cron daemon in the background
- **See progress at localhost:4200** -- built-in web dashboard shows scores, mutation history, and anti-patterns
- **Works with Anthropic, OpenAI, Ollama, Claude Code** -- bring your own provider and model

## CLI Reference

| Command | What it does |
|---------|-------------|
| `kultiv init` | Create `.kultiv/` directory with config and empty archive |
| `kultiv add <name> <path>` | Register an artifact to evolve |
| `kultiv baseline` | Score artifacts without changing them |
| `kultiv run` | Run a single mutation experiment |
| `kultiv evolve -n <N>` | Run N experiments in a session |
| `kultiv status` | Show scores, mutation counts, anti-patterns |
| `kultiv history` | Show experiment archive (most recent first) |
| `kultiv trace "<cmd>"` | Wrap a shell command as a traced run |
| `kultiv pause` | Pause the current evolution session |
| `kultiv resume` | Resume a paused session |
| `kultiv daemon start` | Start the background automation daemon |
| `kultiv daemon stop` | Stop the daemon |
| `kultiv dashboard` | Open the web dashboard at localhost:4200 |

All commands accept `-c, --config <path>` to use a custom config file (defaults to `.kultiv/config.yaml`).

## Configuration

Kultiv stores all state in a `.kultiv/` directory at your project root. The main config file is `.kultiv/config.yaml`.

```yaml
version: "1.0"

# What to evolve -- register with `kultiv add <name> <path>`
artifacts:
  my-agent:
    path: ./agents/my-agent.md       # path to the artifact file
    type: prompt                     # prompt | config | template | doc
    scorer:
      chain:
        - name: typecheck            # human-readable name
          command: "npx tsc --noEmit" # shell command to run
          type: script               # script | pattern | llm-judge
          weight: 3                  # higher = more important
        - name: tests
          command: "npx vitest run"
          type: script
          weight: 2
        - name: quality
          type: llm-judge            # uses configured LLM
          rules_file: .kultiv/judge-rules.md
          weight: 1

# Which LLM to use for mutations
llm:
  provider: anthropic                # anthropic | openai | ollama | claude-code
  model: claude-sonnet-4-20250514
  auth_env: ANTHROPIC_API_KEY        # env var holding your key

# How many experiments to run
evolution:
  budget_per_session: 10             # max mutations per session
  feedback_interval: 3               # check for anti-patterns every 3 runs
  outer_interval: 10                 # revise mutation strategy every 10 runs
  plateau_window: 5                  # detect plateaus over 5-run windows

# Unattended evolution
automation:
  hook_mode: false                   # trigger from Claude Code hooks
  daemon_mode: false                 # run on a cron schedule
  daemon_schedule: "*/30 * * * *"    # every 30 minutes
  cooldown_minutes: 10               # minimum gap between sessions
  auto_commit: true                  # git commit improvements
  auto_push: false                   # manual push (safety default)
  max_regressions_before_pause: 3    # stop after 3 bad results

# Web dashboard
dashboard:
  port: 4200
  open_browser: true

# Self-improving mutation strategy
meta_strategy_path: .kultiv/meta-strategy.md
```

## Scoring System

Kultiv scores artifacts using a chain of evaluators. Each one runs independently and contributes a weighted score.

**Command scorers** (`type: script`) -- run a shell command, derive score from exit code/output. Deterministic, zero tokens.

```yaml
- name: typecheck
  command: "npx tsc --noEmit"
  type: script
  weight: 3
```

**Pattern scorers** (`type: pattern`) -- regex rules against artifact content. Good for structural checks.

```yaml
- name: structure
  type: pattern
  rules_file: .kultiv/pattern-rules.yaml
  weight: 1
```

**LLM judges** (`type: llm-judge`) -- send artifact to the LLM with a rubric. Nuanced but costs tokens.

```yaml
- name: quality
  type: llm-judge
  rules_file: .kultiv/judge-rubric.md
  weight: 1
```

**Total score** = weighted sum across all evaluators, normalized to 100.

## Mutation Types

| Type | What it does | When to use |
|------|-------------|-------------|
| `ADD_RULE` | Add a new instruction | Test failed because a behavior is missing |
| `ADD_EXAMPLE` | Add a "do this" example | Rule exists but agent misapplies it |
| `ADD_NEGATIVE_EXAMPLE` | Add a "don't do this" example | Same mistake keeps happening |
| `REORDER` | Move a section up or down | Important rule is buried too deep |
| `SIMPLIFY` | Remove redundant content | Artifact is bloated with low improvement |
| `REPHRASE` | Rewrite for clarity | Scores fluctuate on the same content |
| `DELETE_RULE` | Remove a rule | Rule consistently makes things worse |
| `MERGE_RULES` | Combine related rules | Several scattered rules cover the same topic |
| `RESTRUCTURE` | Reorganize the whole artifact | Related content is too far apart |

Kultiv picks mutation types based on the meta-strategy and recent results. It avoids repeating the same type twice in a row and forces structural mutations after 3 consecutive additions.

## LLM Providers

### Anthropic

```yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514
  auth_env: ANTHROPIC_API_KEY
```

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

### Ollama (local, free)

```yaml
llm:
  provider: ollama
  model: llama3
```

```bash
ollama serve && ollama pull llama3
```

### Claude Code CLI

```yaml
llm:
  provider: claude-code
  model: claude-sonnet-4-20250514
```

Uses your existing Claude Code subscription. No separate key needed.

## Automation

Kultiv can run unattended in two modes.

### Hook mode

Integrates with Claude Code post-session hooks. After each coding session, a pending file drops into `.kultiv/pending/`. On the next `kultiv evolve` or daemon tick, pending items get processed.

```yaml
automation:
  hook_mode: true
  trigger_after: 1
  cooldown_minutes: 10
```

### Daemon mode

Runs in the background on a cron schedule. Checks for pending work, evolves, and respects cooldown and regression limits.

```yaml
automation:
  daemon_mode: true
  daemon_schedule: "*/30 * * * *"
  auto_commit: true
  max_regressions_before_pause: 3
```

```bash
kultiv daemon start
kultiv daemon stop
```

The daemon writes a PID to `.kultiv/daemon.pid` and uses `.kultiv/lock` to prevent overlapping sessions.

### Safety controls

- Cooldown timer prevents running too frequently
- Regression limit pauses after N bad results
- Lockfile prevents overlapping sessions
- `auto_push` defaults to false -- you always review before pushing

## Presets

Start with a config tuned for your stack:

```bash
kultiv init --preset nextjs
```

| Preset | Evaluators | Best for |
|--------|-----------|----------|
| `standard` | Placeholder scorer | Any project (default) |
| `nextjs` | tsc, eslint, next build | Next.js apps |
| `typescript` | tsc, eslint, vitest | TypeScript libraries |
| `python` | mypy, pytest, ruff | Python projects |
| `go` | go vet, go test, golangci-lint | Go projects |
| `rust` | cargo check, cargo test, clippy | Rust projects |

## Architecture

```
src/
  core/           config, archive (JSONL), artifact reader, trace store
  scoring/        chain runner, command scorer, pattern scorer, LLM judge
  mutation/       single-call LLM engine, apply/revert, type selection
  detection/      plateau + anti-pattern heuristics (zero LLM tokens)
  loops/          inner loop (mutate/score), outer loop (meta-strategy)
  automation/     cron daemon, hook trigger, pending queue, lockfile
  llm/            Anthropic, OpenAI, Ollama, Claude Code adapters
  safety/         git branch-per-experiment, auto-merge, auto-abandon
  dashboard/      Preact SPA served at localhost:4200

bin/
  kultiv.ts       CLI entry point (Commander.js)

templates/
  config.template.yaml       default config
  meta-strategy.template.md  default mutation strategy
```

### Data flow

```
Artifact  -->  Score (test chain)  -->  Baseline archived
    |
    v
Single LLM call  -->  Apply tweak  -->  Re-score  -->  Compare
    |                                                      |
    v                                                      v
 Keep (better)                                    Revert (worse)
    |
    v
 Archive entry  -->  Anti-pattern check  -->  Strategy revision
```

## Contributing

```bash
git clone https://github.com/ronslicker0/kultiv.git
cd kultiv
npm install
npm run build
npm test
```

1. Create a branch for your feature or fix
2. Write tests (`vitest`)
3. Ensure `npm run build && npm run lint && npm test` passes
4. Submit a pull request

**Good first contributions:** new LLM adapters (`src/llm/`), new mutation types, new evaluator types, presets for more languages, dashboard improvements.

## License

MIT -- see [LICENSE](LICENSE) for details.
