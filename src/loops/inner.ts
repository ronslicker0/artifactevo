import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPatch } from 'diff';
import type { EvoConfig } from '../core/config.js';
import { Archive, type ArchiveEntry } from '../core/archive.js';
import { loadArtifact } from '../core/artifact.js';
import type { LLMProvider } from '../llm/provider.js';
import { proposeMutation, type MutationContext } from '../mutation/single-call.js';
import { applyMutation, revertMutation, cleanupBackup } from '../mutation/apply.js';
import { runChain, type Scorecard } from '../scoring/chain-runner.js';
import {
  isGitRepo,
  isWorkingTreeClean,
  createExperimentBranch,
  commitExperiment,
  mergeExperiment,
  abandonExperiment,
  returnToBaseBranch,
  type GitSafetyContext,
} from '../safety/git.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface InnerLoopResult {
  genid: number;
  artifact: string;
  score: number | null;
  maxScore: number;
  mutationType: string;
  status: 'success' | 'regression' | 'crash' | 'neutral';
  diff: string | null;
  tokenCost: number;
}

// ── Inner Loop ──────────────────────────────────────────────────────────

/**
 * Execute a single mutation experiment on an artifact.
 *
 * Flow:
 * 1. Load artifact from config
 * 2. Read meta-strategy
 * 3. Select parent from archive (best-scoring entry)
 * 4. Run scoring chain for baseline
 * 5. Build mutation context with artifact, scorecard, history
 * 6. Propose mutation via LLM
 * 7. If dry run: return without applying
 * 8. Apply mutation to artifact file
 * 9. Score the mutated artifact
 * 10. Compare: keep if improved/neutral, revert if regression
 * 11. Log to archive
 * 12. Return result
 */
export async function innerLoop(
  config: EvoConfig,
  artifactId: string,
  archive: Archive,
  provider: LLMProvider,
  options?: { dryRun?: boolean; safe?: boolean },
): Promise<InnerLoopResult> {
  const genid = archive.getNextGenId();
  const artifactConfig = config.artifacts[artifactId];

  if (!artifactConfig) {
    throw new Error(`Artifact "${artifactId}" not found in config`);
  }

  // 1. Load artifact
  const artifact = loadArtifact(artifactId, artifactConfig);
  const projectRoot = resolve('.');

  // 2. Read meta-strategy
  let metaStrategy: string;
  try {
    metaStrategy = readFileSync(resolve(config.meta_strategy_path), 'utf-8');
  } catch {
    metaStrategy = '(no meta-strategy file found — using default behavior)';
  }

  // 3. Select parent (best-scoring entry for this artifact)
  const parentEntries = archive.getByArtifact(artifactId).filter((e) => e.score !== null);
  const parent = parentEntries.length > 0
    ? parentEntries.reduce((best, e) =>
        (e.score ?? 0) > (best.score ?? 0) ? e : best
      )
    : null;

  // 4. Run scoring chain for baseline
  const chainOptions = {
    provider,
    artifactContent: artifact.content,
    artifactPath: artifact.path,
  };
  let baselineScorecard: Scorecard;
  try {
    baselineScorecard = await runChain(artifactConfig.scorer.chain, projectRoot, chainOptions);
  } catch (err) {
    return makeCrashResult(genid, artifactId, archive, err);
  }

  // 5. Build mutation context
  const archiveHistory = archive.getByArtifact(artifactId).slice(-5);
  const context: MutationContext = {
    artifact: artifact.content,
    artifactType: artifact.type,
    scorecard: baselineScorecard,
    archiveHistory,
    metaStrategy,
  };

  // 6. Propose mutation
  let mutationResult;
  try {
    mutationResult = await proposeMutation(context, provider);
  } catch (err) {
    return makeCrashResult(genid, artifactId, archive, err);
  }

  const tokenCost = mutationResult.input_tokens + mutationResult.output_tokens;
  const mutationType = mutationResult.output.mutation_type;
  const updatedContent = mutationResult.output.updated_artifact;

  // Compute diff
  const diff = createPatch(
    artifact.path,
    artifact.content,
    updatedContent,
    'original',
    'mutated',
  );

  // 7. Dry run — return without applying
  if (options?.dryRun) {
    return {
      genid,
      artifact: artifactId,
      score: baselineScorecard.total_score,
      maxScore: baselineScorecard.max_score,
      mutationType,
      status: 'neutral',
      diff,
      tokenCost,
    };
  }

  // 7b. Git safety — create experiment branch if enabled
  const useGitSafety = options?.safe && isGitRepo(projectRoot);
  let gitCtx: GitSafetyContext | null = null;

  if (useGitSafety) {
    if (!isWorkingTreeClean(projectRoot)) {
      return makeCrashResult(
        genid,
        artifactId,
        archive,
        new Error('Git working tree is not clean. Commit or stash changes before running in safe mode.'),
      );
    }
    gitCtx = { projectRoot, genid };
    try {
      createExperimentBranch(gitCtx);
    } catch (err) {
      return makeCrashResult(genid, artifactId, archive, err);
    }
  }

  // 8. Apply mutation
  let backupPath: string;
  try {
    const result = applyMutation(artifact.path, updatedContent);
    backupPath = result.backupPath;
  } catch (err) {
    if (gitCtx) abandonExperiment(gitCtx);
    return makeCrashResult(genid, artifactId, archive, err);
  }

  // 9. Score the mutated artifact
  let newScorecard: Scorecard;
  try {
    const mutatedOptions = {
      provider,
      artifactContent: updatedContent,
      artifactPath: artifact.path,
    };
    newScorecard = await runChain(artifactConfig.scorer.chain, projectRoot, mutatedOptions);
  } catch (err) {
    // Scoring failed — revert and report crash
    try {
      revertMutation(artifact.path, backupPath);
    } catch { /* best effort */ }
    if (gitCtx) abandonExperiment(gitCtx);
    return makeCrashResult(genid, artifactId, archive, err);
  }

  // 10. Compare scores
  const baselineScore = baselineScorecard.total_score;
  const newScore = newScorecard.total_score;
  const maxScore = newScorecard.max_score;

  let status: 'success' | 'regression' | 'neutral';
  if (newScore > baselineScore) {
    status = 'success';
    cleanupBackup(backupPath);
    // Git safety: commit successful mutation and merge back
    if (gitCtx) {
      try {
        commitExperiment(gitCtx, `kultiv: gen ${genid} ${mutationType} score ${newScore}/${maxScore}`);
        mergeExperiment(gitCtx);
      } catch {
        // Merge failed — leave branch for manual resolution
        returnToBaseBranch(projectRoot);
      }
    }
  } else if (newScore < baselineScore) {
    status = 'regression';
    revertMutation(artifact.path, backupPath);
    // Git safety: abandon the experiment branch (discards changes)
    if (gitCtx) abandonExperiment(gitCtx);
  } else {
    // Equal score — keep the mutation (neutral/lateral move)
    status = 'neutral';
    cleanupBackup(backupPath);
  }

  // In safe mode, revert neutral mutations too
  if (options?.safe && status === 'neutral') {
    revertMutation(artifact.path, backupPath);
    if (gitCtx) abandonExperiment(gitCtx);
  }

  // Git safety: always ensure we return to base branch
  if (useGitSafety) {
    returnToBaseBranch(projectRoot);
  }

  // 11. Log to archive
  const entry: ArchiveEntry = {
    genid,
    artifact: artifactId,
    parent: parent?.genid ?? null,
    score: newScore,
    max_score: maxScore,
    challenge: null,
    run_id: null,
    diff,
    mutation_type: mutationType,
    mutation_desc: mutationResult.output.diagnosis,
    status,
    timestamp: new Date().toISOString(),
    token_cost: tokenCost,
    automated: false,
  };
  archive.append(entry);

  // 12. Return result
  return {
    genid,
    artifact: artifactId,
    score: newScore,
    maxScore: maxScore,
    mutationType,
    status,
    diff,
    tokenCost,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function makeCrashResult(
  genid: number,
  artifactId: string,
  archive: Archive,
  err: unknown,
): InnerLoopResult {
  const entry: ArchiveEntry = {
    genid,
    artifact: artifactId,
    parent: null,
    score: null,
    max_score: 0,
    challenge: null,
    run_id: null,
    diff: null,
    mutation_type: 'CRASH',
    mutation_desc: String(err),
    status: 'crash',
    timestamp: new Date().toISOString(),
    token_cost: null,
    automated: false,
  };
  archive.append(entry);

  return {
    genid,
    artifact: artifactId,
    score: null,
    maxScore: 0,
    mutationType: 'CRASH',
    status: 'crash',
    diff: null,
    tokenCost: 0,
  };
}
