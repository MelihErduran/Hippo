import {
  ProviderError, parseJsonText, postJson, schemaInstruction, validated,
  type FetchLike, type JsonRequest, type JsonResult, type LlmProvider, type Tier,
} from './provider.js';

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Gemini via generateContent with JSON response mode. */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  constructor(
    private opts: { apiKey: string; baseUrl: string; fastModel: string; smartModel: string },
    private fetchFn: FetchLike = fetch,
  ) {}

  modelFor(tier: Tier): string {
    return tier === 'fast' ? this.opts.fastModel : this.opts.smartModel;
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const model = this.modelFor(req.tier);
    const started = Date.now();
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const { data, usage } = await validated(req.schema, async (correction) => {
      const text = `${req.prompt}\n\n${schemaInstruction(req.schema)}${correction ? `\n\n${correction}` : ''}`;
      const res = (await postJson(this.fetchFn, url, { 'x-goog-api-key': this.opts.apiKey }, {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: req.maxTokens ?? 2048 },
      })) as GeminiResponse;
      const cand = res.candidates?.[0];
      const out = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!out) throw new ProviderError(`Gemini returned no text (finishReason: ${cand?.finishReason ?? 'unknown'})`);
      return {
        raw: parseJsonText(out),
        usage: {
          inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    });
    return { data, usage, model, provider: this.name, ms: Date.now() - started };
  }
}
