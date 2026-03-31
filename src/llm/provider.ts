import type { LLMConfig } from '../core/config.js';
import { AnthropicProvider } from './anthropic.js';

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
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config.model, config.auth_env);

    case 'openai':
      throw new Error('OpenAI provider not yet implemented');

    case 'claude-code':
      throw new Error('Claude Code provider not yet implemented');

    default:
      throw new Error(`Unknown LLM provider: ${config.provider as string}`);
  }
}
