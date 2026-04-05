import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

// ── Backup Extension ────────────────────────────────────────────────────

const BACKUP_SUFFIX = '.kultiv-backup';

// ── Apply Mutation ──────────────────────────────────────────────────────

/**
 * Apply a mutation by backing up the current artifact and writing the updated content.
 *
 * @param artifactPath - Absolute path to the artifact file
 * @param updatedContent - The new content to write
 * @returns The path to the backup file
 */
export function applyMutation(
  artifactPath: string,
  updatedContent: string
): { backupPath: string } {
  const backupPath = artifactPath + BACKUP_SUFFIX;

  // Read current content and create backup
  const currentContent = readFileSync(artifactPath, 'utf-8');
  writeFileSync(backupPath, currentContent, 'utf-8');

  // Write the updated artifact
  writeFileSync(artifactPath, updatedContent, 'utf-8');

  return { backupPath };
}

// ── Revert Mutation ─────────────────────────────────────────────────────

/**
 * Revert a mutation by restoring from backup and deleting the backup file.
 *
 * @param artifactPath - Absolute path to the artifact file
 * @param backupPath - Path to the backup file created by applyMutation
 */
export function revertMutation(artifactPath: string, backupPath: string): void {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  const backupContent = readFileSync(backupPath, 'utf-8');
  writeFileSync(artifactPath, backupContent, 'utf-8');
  unlinkSync(backupPath);
}

// ── Cleanup Backup ──────────────────────────────────────────────────────

/**
 * Delete a backup file after a successful mutation is confirmed.
 *
 * @param backupPath - Path to the backup file to delete
 */
export function cleanupBackup(backupPath: string): void {
  if (existsSync(backupPath)) {
    unlinkSync(backupPath);
  }
}
