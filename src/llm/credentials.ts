import type { LLMConfig } from '../core/config.js';

// ── Resolved Credentials ────────────────────────────────────────────────

export interface ResolvedCredentials {
  apiKey?: string;
  oauthToken?: string;
}

/**
 * Resolve credentials from an LLM config.
 *
 * Priority order:
 *   1. Direct values (`oauth_token`, `api_key`)
 *   2. Environment variables (`oauth_token_env`, `auth_env`)
 */
export function resolveCredentials(config: LLMConfig): ResolvedCredentials {
  let oauthToken: string | undefined;
  if (config.oauth_token) {
    oauthToken = config.oauth_token;
  } else if (config.oauth_token_env) {
    oauthToken = process.env[config.oauth_token_env];
  }

  let apiKey: string | undefined;
  if (config.api_key) {
    apiKey = config.api_key;
  } else if (config.auth_env) {
    apiKey = process.env[config.auth_env];
  }

  return { apiKey, oauthToken };
}
