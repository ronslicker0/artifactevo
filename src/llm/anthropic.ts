import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMResponse, LLMGenerateOptions } from './provider.js';
import type { ResolvedCredentials } from './credentials.js';

// ── Anthropic Provider ───────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string, credentials: ResolvedCredentials) {
    if (credentials.oauthToken) {
      this.client = new Anthropic({ authToken: credentials.oauthToken });
    } else if (credentials.apiKey) {
      this.client = new Anthropic({ apiKey: credentials.apiKey });
    } else {
      throw new Error(
        'Anthropic requires either an API key or OAuth token. ' +
        'Set api_key / auth_env or oauth_token / oauth_token_env in your config.'
      );
    }

    this.model = model;
  }

  async generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions
  ): Promise<LLMResponse> {
    const maxTokens = options?.maxTokens ?? 4096;
    const temperature = options?.temperature ?? 0.7;

    const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages: anthropicMessages,
    });

    // Extract text from content blocks
    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      content,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
  }
}
