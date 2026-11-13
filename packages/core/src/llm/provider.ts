import { z } from 'zod';

// One interface for every model provider: "give me JSON matching this schema".
// Providers use plain fetch (no SDKs) so this runs in Node, browsers and Tauri.

export type Tier = 'fast' | 'smart';

export interface JsonRequest<T> {
  agent: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  schemaDescription: string;
  tier: Tier;
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface JsonResult<T> {
  data: T;
  usage: Usage;
  model: string;
  provider: string;
  ms: number;
}

export interface LlmProvider {
  readonly name: string;
  modelFor(tier: Tier): string;
  generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** JSON Schema for a zod schema, minus the $schema key some APIs reject. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

export function schemaInstruction(schema: z.ZodType): string {
  return `Respond with only a JSON object (no prose, no code fences) that matches this JSON Schema:\n${JSON.stringify(jsonSchemaOf(schema))}`;
}

/** Parse model text that should be JSON, tolerating ```json fences. */
export function parseJsonText(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fenced ? fenced[1]! : t;
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(body.slice(first, last + 1));
    throw new ProviderError(`Model did not return JSON: ${t.slice(0, 120)}`);
  }
}

/**
 * Shared validate-and-retry loop. `call` gets an optional correction message
 * describing what was wrong with the previous attempt.
 */
export async function validated<T>(
  schema: z.ZodType<T>,
  call: (correction: string | null) => Promise<{ raw: unknown; usage: Usage }>,
): Promise<{ data: T; usage: Usage }> {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let correction: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await call(correction);
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    const parsed = schema.safeParse(res.raw);
    if (parsed.success) return { data: parsed.data, usage };
    correction = `Your previous output failed validation:\n${parsed.error.issues
      .slice(0, 8)
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')}\nReturn corrected JSON only.`;
  }
  throw new ProviderError(`Model output failed schema validation twice. ${correction ?? ''}`);
}

export async function postJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown, timeoutMs = 60_000): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProviderError(`Network error calling ${new URL(url).host}: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      detail = typeof j.error === 'string' ? j.error : j.error?.message ?? detail;
    } catch { /* keep raw text */ }
    throw new ProviderError(`${new URL(url).host} returned ${res.status}: ${detail}`, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${new URL(url).host} returned non-JSON response`);
  }
}
