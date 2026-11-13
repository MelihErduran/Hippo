import {
  ProviderError, jsonSchemaOf, parseJsonText, postJson, validated,
  type FetchLike, type JsonRequest, type JsonResult, type LlmProvider, type Tier,
} from './provider.js';

interface AnthropicResponse {
  content?: { type: string; input?: unknown; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/** Models that reject tool_choice type "tool" / "any" (Sonnet 5.5 migration). */
export function supportsForcedToolChoice(model: string): boolean {
  const m = model.toLowerCase();
  return !(
    m.includes('claude-sonnet-5-5') ||
    m.includes('claude-opus-5-5') ||
    /claude-fable-5(?:-|\b)/.test(m)
  );
}

/**
 * Shape a zod JSON Schema for Anthropic structured outputs / strict tools:
 * additionalProperties:false on objects, oneOf→anyOf, drop unsupported constraints.
 */
export function forAnthropicStructuredSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set([
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'minContains', 'maxContains',
  ]);

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (drop.has(k)) continue;
      if (k === 'oneOf') {
        out.anyOf = (v as unknown[]).map(walk);
        continue;
      }
      if (k === 'minItems' && typeof v === 'number' && v > 1) continue;
      out[k] = walk(v);
    }
    const types = out.type === undefined ? [] : Array.isArray(out.type) ? out.type : [out.type];
    if (types.includes('object') || (out.properties && !out.type)) {
      out.additionalProperties = false;
      if (!out.type) out.type = 'object';
    }
    return out;
  };

  return walk(schema) as Record<string, unknown>;
}

function isForcedToolUnsupported(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /tool_choice.*(?:type\s+)?"?(?:tool|any)"?.*not supported/i.test(msg)
    || /tool_choice: type "tool" and "any" are not supported/i.test(msg);
}

function usageOf(res: AnthropicResponse) {
  return { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
}

function textFrom(res: AnthropicResponse): string {
  return (res.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('');
}

/** Claude via the Messages API. Structured JSON via forced tool (Haiku) or output_config (Sonnet 5.5+). */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

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
    if (!supportsForcedToolChoice(model)) {
      return this.viaStructuredOutput(req, model, started);
    }
    try {
      return await this.viaForcedTool(req, model, started);
    } catch (e) {
      if (isForcedToolUnsupported(e)) return this.viaStructuredOutput(req, model, started);
      throw e;
    }
  }

  private async viaForcedTool<T>(req: JsonRequest<T>, model: string, started: number): Promise<JsonResult<T>> {
    const tool = { name: req.schemaName, description: req.schemaDescription, input_schema: jsonSchemaOf(req.schema) };
    const { data, usage } = await validated(req.schema, async (correction) => {
      const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: req.prompt }];
      if (correction) messages[0]!.content += `\n\n${correction}`;
      const res = (await this.post(model, {
        system: req.system,
        messages,
        max_tokens: req.maxTokens ?? 2048,
        tools: [tool],
        tool_choice: { type: 'tool', name: req.schemaName },
      })) as AnthropicResponse;
      const block = res.content?.find((c) => c.type === 'tool_use');
      if (!block) throw new ProviderError(`Claude returned no tool call (stop_reason: ${res.stop_reason ?? 'unknown'})`);
      return { raw: block.input, usage: usageOf(res) };
    });
    return { data, usage, model, provider: this.name, ms: Date.now() - started };
  }

  private async viaStructuredOutput<T>(req: JsonRequest<T>, model: string, started: number): Promise<JsonResult<T>> {
    const schema = forAnthropicStructuredSchema(jsonSchemaOf(req.schema));
    // Sonnet 5.5 defaults to high-effort adaptive thinking that counts toward
    // max_tokens; without room (or with up-front thinking off), JSON truncates.
    const maxTokens = Math.max(req.maxTokens ?? 2048, 8192);
    const { data, usage } = await validated(req.schema, async (correction) => {
      let prompt = req.prompt;
      if (correction) prompt += `\n\n${correction}`;
      const res = (await this.post(model, {
        system: req.system,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        // Lowest thinking mode Sonnet 5.5 accepts (it rejects "disabled").
        thinking: { type: 'between_tools' },
        output_config: {
          format: { type: 'json_schema', schema },
          effort: 'low',
        },
      }, '2026-10-21')) as AnthropicResponse;
      if (res.stop_reason === 'max_tokens') {
        throw new ProviderError('Claude hit max_tokens before finishing structured JSON');
      }
      const text = textFrom(res);
      if (!text) {
        throw new ProviderError(`Claude returned no JSON text (stop_reason: ${res.stop_reason ?? 'unknown'})`);
      }
      return { raw: parseJsonText(text), usage: usageOf(res) };
    });
    return { data, usage, model, provider: this.name, ms: Date.now() - started };
  }

  private post(model: string, body: Record<string, unknown>, apiVersion = '2023-06-01'): Promise<unknown> {
    return postJson(this.fetchFn, `${this.opts.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      'x-api-key': this.opts.apiKey,
      'anthropic-version': apiVersion,
    }, { model, ...body });
  }
}
