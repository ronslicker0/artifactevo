# How Genetic Algorithms Improve AI Agents

AI agents are only as good as their instructions. A poorly worded prompt produces unreliable results. A well-tuned one can double an agent's accuracy. But finding the right wording manually? That's slow, tedious, and doesn't scale when you have dozens of agents.

Genetic algorithms offer a better way.

## The Problem: Manual Prompt Tuning

Most teams improve their AI agent prompts by hand:

1. Read the agent's output
2. Guess what went wrong
3. Edit the prompt
4. Test again
5. Repeat

This works for one agent. It breaks down at five. At twenty, it's impossible to keep up.

## The Solution: Evolve Instead of Edit

Genetic algorithms borrow from biology. Instead of designing the perfect prompt, you:

1. **Score** the current version against real tests (compiler, test suites, linters, LLM judges)
2. **Mutate** it -- add a rule, simplify a section, rephrase an instruction
3. **Test** the mutated version against the same tests
4. **Keep the winner** -- if the mutation scores higher, it survives. If not, it's reverted
5. **Repeat** -- each generation builds on the best version so far

Small improvements compound. A 2% gain per generation becomes a 50%+ improvement after 30 experiments.

## Why This Works for AI Agent Prompts

Prompts are text. Text is easy to mutate. Unlike code (where a single wrong character breaks everything), prompt mutations are forgiving -- a slightly different instruction might work better or worse, but it won't crash.

Genetic algorithms excel when:

- The search space is large (many possible phrasings)
- Small changes can have big effects (word choice matters for LLMs)
- You have a clear fitness function (test suites, linters, judges)

AI agent instructions hit all three.

## Kultiv: A CLI Tool for Prompt Evolution

[Kultiv](https://github.com/ronslicker0/kultiv) is an open-source CLI that applies genetic algorithms to AI agent optimization. It supports 9 mutation types, deterministic scoring (zero LLM tokens for test/lint evaluators), and can run unattended overnight.

```bash
npm install -g kultiv
kultiv init
kultiv add my-agent ./agents/my-agent.md
kultiv evolve -n 30
```

Kultiv uses bilevel evolution: an inner loop mutates and scores your artifacts, while an outer loop evolves the mutation strategy itself. This means Kultiv gets better at improving your agents over time.

### Key features

- **Deterministic-first scoring** -- use your existing test suites, compilers, and linters. LLM judges are optional
- **9 mutation types** -- from adding rules to restructuring entire documents
- **Anti-pattern detection** -- catches plateaus, overfitting, and bloat automatically
- **Multiple LLM providers** -- Anthropic, OpenAI, Ollama (local), Claude Code
- **Automation** -- hook-triggered or cron daemon modes for unattended evolution

## When to Use Genetic Algorithms for AI Agents

- You have **measurable quality criteria** (tests, linters, rubrics)
- Your agent prompts are **longer than 50 lines** (more room for improvement)
- You're maintaining **multiple agents** (manual tuning doesn't scale)
- You want to **optimize overnight** instead of during work hours

## Further Reading

- [Kultiv on GitHub](https://github.com/ronslicker0/kultiv) -- open-source CLI tool
- [Introduction to Genetic Algorithms](https://en.wikipedia.org/wiki/Genetic_algorithm) -- Wikipedia overview
- [Prompt Engineering Guide](https://www.promptingguide.ai/) -- manual techniques that Kultiv automates
