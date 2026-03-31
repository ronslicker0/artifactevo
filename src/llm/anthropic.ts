import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMResponse, LLMGenerateOptions } from './provider.js';

// ── Anthropic Provider ───────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string, apiKeyEnv?: string) {
    const envVar = apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    const apiKey = process.env[envVar];

    if (!apiKey) {
      throw new Error(
        `Anthropic API key not found. Set the ${envVar} environment variable.`
      );
    }

    this.client = new Anthropic({ apiKey });
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
