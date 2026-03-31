import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArtifactConfig } from './config.js';

// ── Types ────────────────────────────────────────────────────────────────

export type ArtifactType = 'prompt' | 'config' | 'template' | 'doc';

export interface Artifact {
  id: string;
  path: string;
  type: ArtifactType;
  content: string;
  lineCount: number;
}

// ── Auto-Detection ───────────────────────────────────────────────────────

const PROMPT_PATTERNS = [
  /^#+ (?:Rules|Instructions)\b/m,
  /\bYou are\b/i,
];

const YAML_FRONT_MATTER_RE = /^---\s*\n/;

/**
 * Auto-detect artifact type from content heuristics.
 *
 * Priority:
 * 1. Has `{{` template variables -> template
 * 2. Has "You are" or "## Rules" / "## Instructions" -> prompt
 * 3. Starts with `{` (JSON) or has YAML front matter -> config
 * 4. Else -> doc
 */
export function detectArtifactType(content: string): ArtifactType {
  // Template detection — highest priority since prompts can also have "You are"
  if (content.includes('{{')) {
    return 'template';
  }

  // Prompt detection
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(content)) {
      return 'prompt';
    }
  }

  // Config detection
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || YAML_FRONT_MATTER_RE.test(trimmed)) {
    return 'config';
  }

  return 'doc';
}

// ── Loader ───────────────────────────────────────────────────────────────

/**
 * Load an artifact from disk using its config definition.
 */
export function loadArtifact(id: string, config: ArtifactConfig): Artifact {
  const absolutePath = resolve(config.path);

  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Artifact file not found: ${absolutePath} (artifact: ${id})`);
    }
    throw new Error(`Failed to read artifact "${id}": ${String(err)}`);
  }

  const lineCount = content.split('\n').length;

  return {
    id,
    path: absolutePath,
    type: config.type,
    content,
    lineCount,
  };
}
