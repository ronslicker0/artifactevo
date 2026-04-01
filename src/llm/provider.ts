import type { LLMConfig } from '../core/config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { resolveCredentials } from './credentials.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
}

export interface LLMGenerateOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface LLMProvider {
  generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Create an LLM provider instance based on config.
 */
export function createProvider(config: LLMConfig): LLMProvider {
  const creds = resolveCredentials(config);

  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config.model, creds);

    case 'openai':
      return new OpenAIProvider(config.model, creds);

    case 'ollama':
      return new OllamaProvider(config.model, config.base_url);

    case 'claude-code':
      return new ClaudeCodeProvider(config.model);

    default:
      throw new Error(`Unknown LLM provider: ${config.provider as string}`);
  }
}
