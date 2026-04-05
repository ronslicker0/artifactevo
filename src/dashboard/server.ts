// ── Kultiv Dashboard Server ────────────────────────────────────────
// Hono HTTP server serving the SPA and JSON API routes.
// Reads directly from .kultiv/ files — no database.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { Archive } from '../core/archive.js';
import { loadConfig, type EvoConfig } from '../core/config.js';
import { listRuns } from '../core/trace-store.js';
import { detectAntiPatterns } from '../detection/anti-patterns.js';
import { getDashboardHTML } from './html.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function getArchive(evoDir: string): Archive {
  return new Archive(join(evoDir, 'archive.jsonl'));
}

// ── Server ──────────────────────────────────────────────────────────────

export async function startDashboard(
  port: number,
  evoDir: string,
  openBrowser: boolean,
): Promise<void> {
  const app = new Hono();
  const absEvoDir = resolve(evoDir);

  // ── SPA ─────────────────────────────────────────────────────────────
  app.get('/', (c) => c.html(getDashboardHTML()));

  // ── API: Status ─────────────────────────────────────────────────────
  app.get('/api/status', (c) => {
    if (!existsSync(absEvoDir)) {
      return c.json({ initialized: false });
    }

    const archive = getArchive(absEvoDir);
    const all = archive.getAll();
    const experiments = all.filter((e) => e.status !== 'baseline');
    const successes = experiments.filter((e) => e.status === 'success');
    const regressions = experiments.filter((e) => e.status === 'regression');
    const tokens = all.reduce((sum, e) => sum + (e.token_cost ?? 0), 0);
    const artifactIds = [...new Set(all.map((e) => e.artifact))];

    const session = readJsonSafe<{ status: string; current_experiment: number; total_budget: number }>(
      join(absEvoDir, 'session-state.json'),
    );

    const lockActive = existsSync(join(absEvoDir, 'lock'));

    return c.json({
      initialized: true,
      artifact_count: artifactIds.length,
      experiment_count: experiments.length,
      success_count: successes.length,
      regression_count: regressions.length,
      success_rate: experiments.length > 0 ? Math.round((successes.length / experiments.length) * 100) : 0,
      total_tokens: tokens,
      session: session ? { status: session.status, progress: session.current_experiment, budget: session.total_budget } : null,
      lock_active: lockActive,
    });
  });

  // ── API: Artifacts ──────────────────────────────────────────────────
  app.get('/api/artifacts', (c) => {
    const configPath = join(absEvoDir, 'config.yaml');
    if (!existsSync(configPath)) return c.json([]);

    let config: EvoConfig;
    try {
      config = loadConfig(configPath);
    } catch {
      return c.json([]);
    }

    const archive = getArchive(absEvoDir);
    const all = archive.getAll();

    const artifacts = Object.entries(config.artifacts).map(([id, art]) => {
      const entries = all.filter((e) => e.artifact === id);
      const scores = entries.map((e) => e.score).filter((s): s is number => s !== null);
      const best = scores.length > 0 ? Math.max(...scores) : null;
      const maxScore = entries.length > 0 ? entries[entries.length - 1].max_score : 100;
      const mutations = entries.filter((e) => e.status !== 'baseline').length;
      const successes = entries.filter((e) => e.status === 'success').length;
      const last = entries[entries.length - 1];

      return {
        id,
        path: art.path,
        type: art.type,
        best_score: best,
        max_score: maxScore,
        mutations,
        successes,
        success_rate: mutations > 0 ? Math.round((successes / mutations) * 100) : 0,
        last_mutation_type: last?.mutation_type ?? null,
        last_timestamp: last?.timestamp ?? null,
      };
    });

    return c.json(artifacts);
  });

  // ── API: Artifact Detail ────────────────────────────────────────────
  app.get('/api/artifacts/:id', (c) => {
    const id = c.req.param('id');
    const archive = getArchive(absEvoDir);
    const entries = archive.getAll().filter((e) => e.artifact === id);

    const scoreHistory = entries
      .filter((e) => e.score !== null)
      .map((e) => ({ genid: e.genid, score: e.score, max_score: e.max_score, type: e.mutation_type, status: e.status, timestamp: e.timestamp }));

    const recentMutations = entries
      .filter((e) => e.status !== 'baseline')
      .slice(-20)
      .reverse();

    return c.json({ id, score_history: scoreHistory, recent_mutations: recentMutations });
  });

  // ── API: Archive ────────────────────────────────────────────────────
  app.get('/api/archive', (c) => {
    const archive = getArchive(absEvoDir);
    let entries = archive.getAll();

    const artifact = c.req.query('artifact');
    if (artifact) entries = entries.filter((e) => e.artifact === artifact);

    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    entries = entries.slice(-limit).reverse();

    return c.json(entries);
  });

  // ── API: Traces ─────────────────────────────────────────────────────
  app.get('/api/traces', (c) => {
    const runs = listRuns(absEvoDir);
    const artifact = c.req.query('artifact');
    const filtered = artifact ? runs.filter((r) => r.artifact_id === artifact) : runs;
    return c.json(filtered.slice(-100).reverse());
  });

  // ── API: Trace Detail ───────────────────────────────────────────────
  app.get('/api/traces/:runId', (c) => {
    const runId = c.req.param('runId');
    const runDir = join(absEvoDir, 'traces', 'runs', runId);

    if (!existsSync(runDir)) return c.json({ error: 'Run not found' }, 404);

    const manifest = readJsonSafe(join(runDir, 'manifest.json'));
    const scorecard = readJsonSafe(join(runDir, 'scorecard.json'));
    const errors = readJsonSafe(join(runDir, 'errors.json'));

    return c.json({ manifest, scorecard, errors });
  });

  // ── API: Anti-patterns ──────────────────────────────────────────────
  app.get('/api/anti-patterns', (c) => {
    const archive = getArchive(absEvoDir);
    const all = archive.getAll();
    const artifactIds = [...new Set(all.map((e) => e.artifact))];

    const patterns = artifactIds.flatMap((id) =>
      detectAntiPatterns([...all], id).map((p) => ({ ...p, artifact: id })),
    );

    return c.json(patterns);
  });

  // ── API: Config (sanitized) ─────────────────────────────────────────
  app.get('/api/config', (c) => {
    const configPath = join(absEvoDir, 'config.yaml');
    if (!existsSync(configPath)) return c.json({ error: 'Not initialized' }, 404);

    try {
      const config = loadConfig(configPath);
      // Sanitize: remove auth keys
      const sanitized = {
        ...config,
        llm: {
          provider: config.llm.provider,
          model: config.llm.model,
          auth_env: config.llm.auth_env ? '***' : undefined,
          oauth_token_env: config.llm.oauth_token_env ? '***' : undefined,
          base_url: config.llm.base_url,
        },
      };
      return c.json(sanitized);
    } catch {
      return c.json({ error: 'Invalid config' }, 500);
    }
  });

  // ── API: Add Artifact ───────────────────────────────────────────────
  app.post('/api/artifacts', async (c) => {
    const body = await c.req.json<{ name: string; path: string; type?: string }>();
    if (!body.name || !body.path) {
      return c.json({ error: 'name and path are required' }, 400);
    }

    const configPath = join(absEvoDir, 'config.yaml');
    if (!existsSync(configPath)) return c.json({ error: 'Not initialized' }, 404);

    try {
      const yaml = await import('js-yaml');
      const raw = readFileSync(configPath, 'utf-8');
      const config = yaml.default.load(raw) as Record<string, unknown>;
      const artifacts = (config.artifacts ?? {}) as Record<string, unknown>;

      artifacts[body.name] = {
        path: body.path,
        type: body.type ?? 'prompt',
        scorer: { chain: [{ name: 'build', command: 'npm run build', weight: 100 }] },
      };
      config.artifacts = artifacts;

      writeFileSync(configPath, yaml.default.dump(config, { lineWidth: 120 }), 'utf-8');
      return c.json({ success: true, artifact: body.name });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // ── API: Test Connection ─────────────────────────────────────────────
  app.post('/api/test-connection', async (c) => {
    const body = await c.req.json<{
      provider: string;
      model: string;
      api_key?: string;
      oauth_token?: string;
      base_url?: string;
    }>();

    const tempConfig = {
      provider: body.provider as 'anthropic' | 'openai' | 'ollama' | 'claude-code',
      model: body.model,
      api_key: body.api_key,
      oauth_token: body.oauth_token,
      base_url: body.base_url,
    };

    const { testConnection } = await import('../llm/test-connection.js');
    const result = await testConnection(tempConfig);
    return c.json(result);
  });

  // ── API: Save Config ────────────────────────────────────────────────
  app.post('/api/config', async (c) => {
    const body = await c.req.json();
    const configPath = join(absEvoDir, 'config.yaml');

    try {
      const yaml = await import('js-yaml');
      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        existing = yaml.default.load(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }
      const merged = { ...existing, ...body };
      writeFileSync(configPath, yaml.default.dump(merged, { lineWidth: 120 }), 'utf-8');
      return c.json({ success: true });
    } catch (err) {
      return c.json({ success: false, error: String(err) }, 500);
    }
  });

  // ── API: Full Config (masked) ───────────────────────────────────────
  app.get('/api/config/full', async (c) => {
    const configPath = join(absEvoDir, 'config.yaml');
    if (!existsSync(configPath)) return c.json({ error: 'Not initialized' }, 404);

    try {
      const yaml = await import('js-yaml');
      const raw = readFileSync(configPath, 'utf-8');
      const config = yaml.default.load(raw) as Record<string, Record<string, unknown>>;

      // Mask sensitive values but indicate they exist
      if (config.llm?.api_key) {
        config.llm.api_key = '***' + String(config.llm.api_key).slice(-4);
      }
      if (config.llm?.oauth_token) {
        config.llm.oauth_token = '***' + String(config.llm.oauth_token).slice(-4);
      }

      return c.json(config);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // ── API: Playground ──────────────────────────────────────────────────

  // List available scorer chains for the dropdown
  app.get('/api/playground/chains', (c) => {
    const configPath = join(absEvoDir, 'config.yaml');
    if (!existsSync(configPath)) return c.json([]);

    try {
      const config = loadConfig(configPath);
      const chains = Object.entries(config.artifacts).map(([id, art]) => ({
        id,
        type: art.type,
        chain_summary: art.scorer.chain.map((ch) => ch.name).join(', '),
      }));
      return c.json(chains);
    } catch {
      return c.json([]);
    }
  });

  // Score arbitrary content against a scorer chain
  app.post('/api/playground/score', async (c) => {
    const body = await c.req.json<{ content: string; type: string; chain: string }>();
    if (!body.content) return c.json({ error: 'content is required' }, 400);

    const configPath = join(absEvoDir, 'config.yaml');
    if (!existsSync(configPath)) return c.json({ error: 'Not initialized' }, 404);

    const projectRoot = resolve(absEvoDir, '..');

    // Write content to a temp file for pattern/script scorers
    const tempFile = join(tmpdir(), `kultiv-playground-${randomUUID()}.txt`);
    writeFileSync(tempFile, body.content, 'utf-8');

    try {
      const config = loadConfig(configPath);
      const { runChain } = await import('../scoring/chain-runner.js');
      const { createProvider } = await import('../llm/factory.js');

      // Build scorer chain
      let chain;
      if (body.chain === 'default') {
        chain = [{ name: 'llm-judge', type: 'llm-judge' as const, weight: 100 }];
      } else {
        const art = config.artifacts[body.chain];
        if (!art) return c.json({ error: `Artifact "${body.chain}" not found` }, 404);
        chain = art.scorer.chain;
      }

      // Create LLM provider if needed
      let provider;
      try {
        provider = createProvider(config.llm);
      } catch {
        // LLM not available — script/pattern scorers still work
      }

      const scorecard = await runChain(chain, projectRoot, {
        provider,
        artifactContent: body.content,
        artifactPath: tempFile,
      });

      return c.json(scorecard);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    } finally {
      try { unlinkSync(tempFile); } catch { /* best effort */ }
    }
  });

  // Save playground content as a new artifact
  app.post('/api/playground/save', async (c) => {
    const body = await c.req.json<{ content: string; name: string; type: string; path: string }>();
    if (!body.content || !body.name || !body.path) {
      return c.json({ error: 'content, name, and path are required' }, 400);
    }

    const configPath = join(absEvoDir, 'config.yaml');
    if (!existsSync(configPath)) return c.json({ error: 'Not initialized' }, 404);

    const projectRoot = resolve(absEvoDir, '..');
    const filePath = resolve(projectRoot, body.path);

    try {
      // Write the content file
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body.content, 'utf-8');

      // Register in config
      const yaml = await import('js-yaml');
      const raw = readFileSync(configPath, 'utf-8');
      const config = yaml.default.load(raw) as Record<string, unknown>;
      const artifacts = (config.artifacts ?? {}) as Record<string, unknown>;

      artifacts[body.name] = {
        path: body.path,
        type: body.type ?? 'prompt',
        scorer: { chain: [{ name: 'llm-judge', type: 'llm-judge', weight: 100 }] },
      };
      config.artifacts = artifacts;

      writeFileSync(configPath, yaml.default.dump(config, { lineWidth: 120 }), 'utf-8');
      return c.json({ success: true, artifact: body.name });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // ── API: Pause / Resume ─────────────────────────────────────────────
  app.post('/api/pause', (c) => {
    const signalPath = join(absEvoDir, 'pause-signal');
    writeFileSync(signalPath, new Date().toISOString(), 'utf-8');
    return c.json({ success: true, message: 'Pause signal sent' });
  });

  app.post('/api/resume', (c) => {
    // Clear pause signal if it exists
    const signalPath = join(absEvoDir, 'pause-signal');
    if (existsSync(signalPath)) {
      unlinkSync(signalPath);
    }
    return c.json({ success: true, message: 'Resume signal sent. Run `kultiv resume` to continue.' });
  });

  // ── Start Server ────────────────────────────────────────────────────
  console.log(`\x1b[32mKultiv Dashboard\x1b[0m → http://localhost:${port}`);

  if (openBrowser) {
    const { exec } = await import('node:child_process');
    const url = `http://localhost:${port}`;
    // Cross-platform open
    const cmd = process.platform === 'win32' ? `start ${url}`
      : process.platform === 'darwin' ? `open ${url}`
      : `xdg-open ${url}`;
    exec(cmd, () => { /* ignore errors */ });
  }

  serve({ fetch: app.fetch, port });
}
