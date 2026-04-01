import { createProvider } from './provider.js';
import type { LLMConfig } from '../core/config.js';

// ── Connection Test ─────────────────────────────────────────────────────

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  latencyMs: number;
}

/**
 * Test an LLM connection by sending a minimal prompt and measuring latency.
 * Returns a result object regardless of success or failure (never throws).
 */
export async function testConnection(config: LLMConfig): Promise<ConnectionTestResult> {
  const start = Date.now();
  try {
    const provider = createProvider(config);
    const response = await provider.generate(
      [{ role: 'user', content: 'Respond with only the word OK' }],
      { maxTokens: 10 },
    );
    return {
      success: true,
      message: response.content.trim().slice(0, 100),
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      message: String(err),
      latencyMs: Date.now() - start,
    };
  }
}
