import { execSync } from 'node:child_process';

// ── Types ────────────────────────────────────────────────────────────────

export interface GitSafetyContext {
  projectRoot: string;
  genid: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function branchName(genid: number): string {
  return `kultiv/exp-${genid}`;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Check whether the given directory is inside a git work tree.
 */
export function isGitRepo(projectRoot: string): boolean {
  try {
    const result = git('rev-parse --is-inside-work-tree', projectRoot);
    return result === 'true';
  } catch {
    return false;
  }
}

/**
 * Check whether the working tree has no uncommitted changes.
 */
export function isWorkingTreeClean(projectRoot: string): boolean {
  try {
    const output = git('status --porcelain', projectRoot);
    return output === '';
  } catch {
    return false;
  }
}

/**
 * Detect the base branch name (main, master, or current branch).
 */
export function getBaseBranch(projectRoot: string): string {
  try {
    // Check if 'main' exists
    git('rev-parse --verify main', projectRoot);
    return 'main';
  } catch {
    // fall through
  }

  try {
    // Check if 'master' exists
    git('rev-parse --verify master', projectRoot);
    return 'master';
  } catch {
    // fall through
  }

  // Fall back to current branch
  try {
    return git('rev-parse --abbrev-ref HEAD', projectRoot);
  } catch {
    return 'main';
  }
}

/**
 * Create a new experiment branch: `kultiv/exp-<genid>`.
 * Returns the branch name.
 */
export function createExperimentBranch(ctx: GitSafetyContext): string {
  const branch = branchName(ctx.genid);
  try {
    git(`checkout -b ${branch}`, ctx.projectRoot);
    return branch;
  } catch (err) {
    throw new Error(
      `Failed to create experiment branch "${branch}": ${String(err)}`,
    );
  }
}

/**
 * Stage all changes and commit with the given message.
 */
export function commitExperiment(ctx: GitSafetyContext, message: string): void {
  try {
    git('add -A', ctx.projectRoot);
    // Use -- to prevent message from being interpreted as flags
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: ctx.projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`Failed to commit experiment: ${String(err)}`);
  }
}

/**
 * Merge the experiment branch back into the base branch with --no-ff,
 * then delete the experiment branch.
 */
export function mergeExperiment(ctx: GitSafetyContext): void {
  const branch = branchName(ctx.genid);
  const baseBranch = getBaseBranch(ctx.projectRoot);

  try {
    git(`checkout ${baseBranch}`, ctx.projectRoot);
    git(`merge ${branch} --no-ff -m "kultiv: merge experiment ${ctx.genid}"`, ctx.projectRoot);
    git(`branch -d ${branch}`, ctx.projectRoot);
  } catch (err) {
    throw new Error(
      `Failed to merge experiment branch "${branch}": ${String(err)}`,
    );
  }
}

/**
 * Abandon an experiment by switching back to base and force-deleting the branch.
 */
export function abandonExperiment(ctx: GitSafetyContext): void {
  const branch = branchName(ctx.genid);
  const baseBranch = getBaseBranch(ctx.projectRoot);

  try {
    git(`checkout ${baseBranch}`, ctx.projectRoot);
  } catch {
    // Best effort — may already be on base branch
  }

  try {
    git(`branch -D ${branch}`, ctx.projectRoot);
  } catch {
    // Branch may not exist if creation failed
  }
}

/**
 * Ensure we are back on the base branch, regardless of current state.
 * Used in finally blocks for cleanup.
 */
export function returnToBaseBranch(projectRoot: string): void {
  const baseBranch = getBaseBranch(projectRoot);
  try {
    git(`checkout ${baseBranch}`, projectRoot);
  } catch {
    // Best effort
  }
}
