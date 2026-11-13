import type { Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAICompatProvider } from './openai.js';
import type { FetchLike, LlmProvider } from './provider.js';

/** Resolves a provider's key: config apiKey, then env, then apiKeyCommand. */
export type KeyResolver = (provider: 'anthropic' | 'gemini' | 'openai') => string | null;

export interface ProviderChoice {
  provider: LlmProvider | null;
  /** Why provider is null, shown by `hippo doctor` and after offline filing. */
  reason: string | null;
}

export function createProvider(config: Config, resolveKey: KeyResolver, fetchFn?: FetchLike): ProviderChoice {
  try {
    switch (config.provider) {
      case 'offline':
        return { provider: null, reason: 'provider is set to offline' };
      case 'anthropic': {
        const key = resolveKey('anthropic');
        if (!key) return { provider: null, reason: 'no Anthropic API key (set ANTHROPIC_API_KEY or anthropic.apiKeyCommand)' };
        return { provider: new AnthropicProvider({ ...config.anthropic, apiKey: key }, fetchFn), reason: null };
      }
      case 'gemini': {
        const key = resolveKey('gemini');
        if (!key) return { provider: null, reason: 'no Gemini API key (set GEMINI_API_KEY or gemini.apiKeyCommand)' };
        return { provider: new GeminiProvider({ ...config.gemini, apiKey: key }, fetchFn), reason: null };
      }
      case 'openai': {
        // Local servers like Ollama need no key.
        return { provider: new OpenAICompatProvider({ ...config.openai, apiKey: resolveKey('openai') }, fetchFn), reason: null };
      }
    }
  } catch (e) {
    return { provider: null, reason: (e as Error).message };
  }
}
