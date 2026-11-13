import {
  ProviderError, parseJsonText, postJson, schemaInstruction, validated,
  type FetchLike, type JsonRequest, type JsonResult, type LlmProvider, type Tier,
} from './provider.js';

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Any OpenAI-compatible Chat Completions endpoint: OpenAI itself, OpenRouter,
 * or local models through Ollama (http://localhost:11434/v1) or LM Studio.
 */
export class OpenAICompatProvider implements LlmProvider {
  readonly name = 'openai';

  constructor(
    private opts: { apiKey: string | null; baseUrl: string; fastModel: string; smartModel: string },
    private fetchFn: FetchLike = fetch,
  ) {
    if (!opts.fastModel || !opts.smartModel) {
      throw new ProviderError('Set openai.fastModel and openai.smartModel in config (e.g. a local Ollama model name).');
    }
  }

  modelFor(tier: Tier): string {
    return tier === 'fast' ? this.opts.fastModel : this.opts.smartModel;
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const model = this.modelFor(req.tier);
    const started = Date.now();
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const { data, usage } = await validated(req.schema, async (correction) => {
      const res = (await postJson(this.fetchFn, `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, headers, {
        model,
        messages: [
          { role: 'system', content: `${req.system}\n\n${schemaInstruction(req.schema)}` },
          { role: 'user', content: correction ? `${req.prompt}\n\n${correction}` : req.prompt },
        ],
        response_format: { type: 'json_object' },
      })) as ChatResponse;
      const out = res.choices?.[0]?.message?.content;
      if (!out) throw new ProviderError(`Model returned no content (finish_reason: ${res.choices?.[0]?.finish_reason ?? 'unknown'})`);
      return {
        raw: parseJsonText(out),
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
      };
    });
    return { data, usage, model, provider: this.name, ms: Date.now() - started };
  }
}
