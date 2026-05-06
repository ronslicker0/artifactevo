import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createPatch } from 'diff';
import type { EvoConfig } from '../core/config.js';
import { Archive, type ArchiveEntry, type ScorecardCheck } from '../core/archive.js';
import { loadArtifact } from '../core/artifact.js';
import type { LLMProvider } from '../llm/provider.js';
import { proposeMutation, type MutationContext } from '../mutation/single-call.js';
import { proposeDialogueMutation } from '../mutation/dialogue.js';
import type { FailureContext, Challenge, SpecifyOutput } from '../mutation/types.js';
import { loadScanAnalysis } from '../mutation/scan.js';
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
import { selectParent } from '../selection/parent.js';
import { selectChallenge } from '../selection/challenge.js';
import { loadChallenges } from '../challenges/loader.js';
import { verifySemantic } from '../guards/semantic-diff.js';
import { crossValidate, detectRegression } from '../scoring/cross-validator.js';
import { readPatternsFile, buildFocusAreasBlock } from '../dreaming/patterns.js';

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

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Extract per-criterion check scores from a scorecard's evaluator details.
 * The LLM judge stores checks in details.checks with { name, score, max, note }.
 */
function extractScorecardChecks(scorecard: Scorecard): ScorecardCheck[] {
  const checks: ScorecardCheck[] = [];
  for (const evaluator of scorecard.evaluators) {
    const rawChecks = evaluator.details?.checks;
    if (Array.isArray(rawChecks)) {
      for (const c of rawChecks) {
        if (typeof c.name === 'string' && typeof c.score === 'number' && typeof c.max === 'number') {
          checks.push({
            name: c.name as string,
            score: c.score as number,
            max: c.max as number,
            ...(typeof c.note === 'string' ? { note: c.note as string } : {}),
          });
        }
      }
    }
  }
  return checks;
}

/**
 * Load failure context from .kultiv/pending/ for a specific artifact.
 * Returns up to 5 most recent errors that have error data.
 */
function loadFailureContext(projectRoot: string, artifactId: string): FailureContext | undefined {
  const pendingDir = join(projectRoot, '.kultiv', 'pending');
  if (!existsSync(pendingDir)) return undefined;

  let files: string[];
  try {
    files = readdirSync(pendingDir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }

  const errors: FailureContext['recentErrors'] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(pendingDir, file), 'utf-8');
      const entry = JSON.parse(raw) as Record<string, unknown>;
      if (entry.artifactId === artifactId && typeof entry.error === 'string') {
        errors.push({
          error: entry.error as string,
          category: String(entry.category ?? 'UNKNOWN'),
          timestamp: String(entry.timestamp ?? ''),
          errorPatterns: Array.isArray(entry.errorPatterns)
            ? (entry.errorPatterns as unknown[]).map(String)
            : undefined,
        });
      }
    } catch {
      // Skip malformed files
    }
  }

  if (errors.length === 0) return undefined;

  // Sort by timestamp descending, take 5 most recent
  errors.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { recentErrors: errors.slice(0, 5) };
}

// ── Inner Loop ──────────────────────────────────────────────────────────

/**
 * Execute a single mutation experiment on an artifact.
 *
 * Flow:
 * 1. Load artifact from config
 * 2. Read meta-strategy
 * 3. Select parent from archive (tournament or greedy)
 * 4. Select challenge (if challenges exist)
 * 5. Run scoring chain for baseline
 * 6. Build mutation context with artifact, scorecard, history
 * 7. Propose mutation via LLM (with beam search if beam_width > 1)
 * 8. Size guard — reject oversized mutations
 * 9. Semantic diff guard — verify mutation scope
 * 10. If dry run: return without applying
 * 11. Apply mutation to artifact file
 * 12. Score the mutated artifact
 * 13. Compare: keep if improved/neutral, revert if regression
 * 14. Cross-validate against other challenges
 * 15. Log to archive
 * 16. Return result
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

  // 3. Select parent (tournament or greedy based on config)
  const parentEntries = archive.getByArtifact(artifactId).filter((e) => e.score !== null);
  const selectionConfig = config.evolution.selection;
  const parent = selectParent(
    parentEntries,
    selectionConfig.parent_method,
    selectionConfig.parent_temperature,
    archive.getByArtifact(artifactId).slice(-5).map(e => e.genid),
  );

  // 4. Challenge selection
  const challengesDir = resolve(projectRoot, '.kultiv', 'challenges', artifactId);
  const challenges = existsSync(challengesDir) ? loadChallenges(challengesDir) : [];
  let selectedChallenge: Challenge | null = null;
  if (challenges.length > 0) {
    selectedChallenge = selectChallenge(
      challenges,
      archive,
      artifactId,
      selectionConfig.challenge_method,
      genid,
    );
  }

  // 5. Run scoring chain for baseline
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

  // 6. Build mutation context
  const archiveHistory = archive.getByArtifact(artifactId).slice(-5);

  // Load rubric content so the mutation LLM knows what the judge scores on
  let rubricContent: string | undefined;
  const llmJudgeChainItem = artifactConfig.scorer.chain.find(
    (item) => item.type === 'llm-judge' && item.rules_file,
  );
  if (llmJudgeChainItem?.rules_file) {
    try {
      rubricContent = readFileSync(resolve(projectRoot, llmJudgeChainItem.rules_file), 'utf-8');
    } catch {
      // Rubric file not found — mutation LLM will proceed without it
    }
  }

  // Extract per-criterion checks from baseline scorecard
  const baselineChecks = extractScorecardChecks(baselineScorecard);

  // Load failure context from pending files (real production errors)
  const failureContext = loadFailureContext(projectRoot, artifactId);

  // Load scan analysis if available
  const kultivDir = resolve(projectRoot, '.kultiv');
  const scanAnalysis = loadScanAnalysis(kultivDir, artifactId);

  // Load dream-surfaced focus areas if available — cross-session patterns
  // bias mutation toward addressing what's actually recurring in real use.
  const dreamPatterns = readPatternsFile(join(kultivDir, 'dreams', 'patterns.md'));
  const dreamFocusAreas = buildFocusAreasBlock(dreamPatterns, artifactId);

  const context: MutationContext = {
    artifact: artifact.content,
    artifactType: artifact.type,
    scorecard: baselineScorecard,
    archiveHistory,
    metaStrategy,
    rubricContent,
    scorecardChecks: baselineChecks.length > 0 ? baselineChecks : undefined,
    failureContext,
    scanAnalysis,
    dreamFocusAreas: dreamFocusAreas.length > 0 ? dreamFocusAreas : undefined,
  };

  // 7. Propose mutation (with beam search support)
  let mutationResult;
  try {
    mutationResult = config.evolution.mutation_mode === 'dialogue'
      ? await proposeDialogueMutation(context, provider, { beamWidth: config.evolution.beam_width })
      : await proposeMutation(context, provider);
  } catch (err) {
    return makeCrashResult(genid, artifactId, archive, err);
  }

  const tokenCost = mutationResult.input_tokens + mutationResult.output_tokens;
  const mutationType = mutationResult.output.mutation_type;
  let updatedContent = mutationResult.output.updated_artifact;

  // 7b. Beam search: if multiple variants, score each and pick the best
  if (mutationResult.variants && mutationResult.variants.length > 1) {
    let bestVariantIdx = 0;
    let bestVariantScore = -Infinity;
    for (let vi = 0; vi < mutationResult.variants.length; vi++) {
      try {
        const variantScorecard = await runChain(artifactConfig.scorer.chain, projectRoot, {
          provider, artifactContent: mutationResult.variants[vi], artifactPath: artifact.path,
        });
        if (variantScorecard.total_score > bestVariantScore) {
          bestVariantScore = variantScorecard.total_score;
          bestVariantIdx = vi;
        }
      } catch {
        // Skip variants that fail to score
      }
    }
    // Use the best variant
    updatedContent = mutationResult.variants[bestVariantIdx];
    // Update mutation result metadata
    if (mutationResult.dialogue_trace) {
      mutationResult.dialogue_trace.selected_variant_index = bestVariantIdx;
    }
  }

  // Compute diff
  const diff = createPatch(
    artifact.path,
    artifact.content,
    updatedContent,
    'original',
    'mutated',
  );

  // 8. Size guard — reject mutations that change artifact size by more than 50%
  const originalLen = artifact.content.length;
  const mutatedLen = updatedContent.length;
  const sizeRatio = mutatedLen / originalLen;
  if (sizeRatio > 1.5 || sizeRatio < 0.5) {
    const sizeDesc = sizeRatio > 1 ? `expanded ${Math.round((sizeRatio - 1) * 100)}%` : `shrunk ${Math.round((1 - sizeRatio) * 100)}%`;
    const entry: ArchiveEntry = {
      genid,
      artifact: artifactId,
      parent: parent?.genid ?? null,
      score: baselineScorecard.total_score,
      max_score: baselineScorecard.max_score,
      challenge: selectedChallenge?.id ?? null,
      run_id: null,
      diff,
      mutation_type: mutationType,
      mutation_desc: `Rejected: artifact ${sizeDesc} (${originalLen} → ${mutatedLen} chars)`,
      status: 'regression',
      timestamp: new Date().toISOString(),
      token_cost: tokenCost,
      automated: false,
    };
    archive.append(entry);
    return {
      genid,
      artifact: artifactId,
      score: baselineScorecard.total_score,
      maxScore: baselineScorecard.max_score,
      mutationType,
      status: 'regression',
      diff,
      tokenCost,
    };
  }

  // 9. Semantic diff guard — verify mutation scope when in dialogue mode
  if (config.evolution.mutation_mode === 'dialogue' && mutationResult.dialogue_trace) {
    const spec: SpecifyOutput = {
      mutation_type: mutationResult.output.mutation_type,
      target_section: mutationResult.output.target_section,
      action: mutationResult.output.action,
      content_spec: mutationResult.output.content,
      integration_constraints: [],
      expected_score_deltas: {},
    };
    const semanticResult = await verifySemantic(artifact.content, updatedContent, spec, provider);
    if (!semanticResult.passed) {
      const entry: ArchiveEntry = {
        genid,
        artifact: artifactId,
        parent: parent?.genid ?? null,
        score: baselineScorecard.total_score,
        max_score: baselineScorecard.max_score,
        challenge: selectedChallenge?.id ?? null,
        run_id: null,
        diff,
        mutation_type: mutationType,
        mutation_desc: `Semantic guard: ${semanticResult.violations.join('; ')}`,
        status: 'regression',
        timestamp: new Date().toISOString(),
        token_cost: tokenCost,
        automated: false,
        ...(mutationResult.dialogue_trace ? { dialogue_trace: mutationResult.dialogue_trace } : {}),
      };
      archive.append(entry);
      return {
        genid,
        artifact: artifactId,
        score: baselineScorecard.total_score,
        maxScore: baselineScorecard.max_score,
        mutationType,
        status: 'regression',
        diff,
        tokenCost,
      };
    }
  }

  // 10. Dry run — return without applying
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

  // 10b. Git safety — create experiment branch if enabled
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

  // 11. Apply mutation
  let backupPath: string;
  try {
    const result = applyMutation(artifact.path, updatedContent);
    backupPath = result.backupPath;
  } catch (err) {
    if (gitCtx) abandonExperiment(gitCtx);
    return makeCrashResult(genid, artifactId, archive, err);
  }

  // 12. Score the mutated artifact
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

  // 13. Compare scores
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
    if (options?.safe) {
      // In safe mode, revert neutral mutations too
      revertMutation(artifact.path, backupPath);
      if (gitCtx) abandonExperiment(gitCtx);
    } else {
      cleanupBackup(backupPath);
    }
  }

  // 14. Cross-validation — check for regressions on other challenges
  let crossValidationScores: Record<string, number> | undefined;
  if (config.evolution.cross_validation_count > 0 && newScore > baselineScore && challenges.length > 1) {
    const cvResults = await crossValidate(
      updatedContent,
      artifact.path,
      challenges.map(c => ({ id: c.id, name: c.name, description: c.description })),
      config.evolution.cross_validation_count,
      selectedChallenge?.id ?? null,
      artifactConfig.scorer.chain,
      projectRoot,
      provider,
    );
    const hasRegression = detectRegression(cvResults, archive, artifactId, 0.05);
    if (hasRegression) {
      // Demote to neutral — the mutation improved current challenge but regressed others
      status = 'neutral';
      revertMutation(artifact.path, backupPath);
      if (gitCtx) abandonExperiment(gitCtx);
    }
    // Record cross-validation scores regardless
    crossValidationScores = {};
    for (const cv of cvResults) {
      crossValidationScores[cv.challengeId] = cv.score;
    }
  }

  // Git safety: always ensure we return to base branch
  if (useGitSafety) {
    returnToBaseBranch(projectRoot);
  }

  // 15. Extract per-criterion checks from scorecard
  const scorecardChecks = extractScorecardChecks(newScorecard);

  // 16. Log to archive
  const entry: ArchiveEntry = {
    genid,
    artifact: artifactId,
    parent: parent?.genid ?? null,
    score: newScore,
    max_score: maxScore,
    challenge: selectedChallenge?.id ?? null,
    run_id: null,
    diff,
    mutation_type: mutationType,
    mutation_desc: mutationResult.output.diagnosis,
    status,
    timestamp: new Date().toISOString(),
    token_cost: tokenCost,
    automated: false,
    ...(mutationResult.dialogue_trace ? { dialogue_trace: mutationResult.dialogue_trace } : {}),
    ...(scorecardChecks.length > 0 ? { scorecard_checks: scorecardChecks } : {}),
    ...(crossValidationScores ? { cross_validation_scores: crossValidationScores } : {}),
    ...(mutationResult.variants && mutationResult.variants.length > 1 ? {
      beam_variants_count: mutationResult.variants.length,
      selected_variant_index: mutationResult.dialogue_trace?.selected_variant_index ?? 0,
    } : {}),
  };
  archive.append(entry);

  // 16. Return result
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
