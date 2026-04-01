import OpenAI from 'openai';
import type { LLMProvider, LLMMessage, LLMResponse, LLMGenerateOptions } from './provider.js';
import type { ResolvedCredentials } from './credentials.js';

// ── OpenAI Provider ─────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(model: string, credentials: ResolvedCredentials) {
    // OAuth tokens and API keys both go through the same apiKey field for OpenAI
    const key = credentials.oauthToken ?? credentials.apiKey;

    if (!key) {
      throw new Error(
        'OpenAI requires either an API key or OAuth token. ' +
        'Set api_key / auth_env or oauth_token / oauth_token_env in your config.'
      );
    }

    this.client = new OpenAI({ apiKey: key });
    this.model = model;
  }

  async generate(
    messages: LLMMessage[],
    options?: LLMGenerateOptions
  ): Promise<LLMResponse> {
    const maxTokens = options?.maxTokens ?? 4096;
    const temperature = options?.temperature ?? 0.7;

    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages: openaiMessages,
    });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? '';

    return {
      content,
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
    };
  }
}
