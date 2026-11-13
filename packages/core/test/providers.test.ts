import { describe, expect, it } from 'vitest';
import { FilerOutput } from '../src/agents/schemas.js';
import { resolveConfig } from '../src/config.js';
import { AnthropicProvider, forAnthropicStructuredSchema, supportsForcedToolChoice } from '../src/llm/anthropic.js';
import { createProvider } from '../src/llm/factory.js';
import { GeminiProvider } from '../src/llm/gemini.js';
import { OpenAICompatProvider } from '../src/llm/openai.js';
import { jsonSchemaOf, parseJsonText } from '../src/llm/provider.js';

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function mockFetch(responses: unknown[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = responses.shift();
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls };
}

const good = { actions: [{ type: 'create_task', title: 'Pay rent', due: '2026-11-05' }], reply: null };
const req = {
  agent: 'filer', system: 'sys', prompt: 'dump', schema: FilerOutput, schemaName: 'file_brain_dump',
  schemaDescription: 'desc', tier: 'fast' as const,
};

describe('AnthropicProvider', () => {
  it('forces a tool call with the JSON schema and reads tool_use input', async () => {
    const { fn, calls } = mockFetch([{ content: [{ type: 'tool_use', input: good }], usage: { input_tokens: 12, output_tokens: 7 } }]);
    const p = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', fastModel: 'claude-haiku-5-5', smartModel: 'claude-sonnet-5-5' }, fn);
    const r = await p.generateJson(req);
    expect(r.data.actions[0]).toMatchObject({ title: 'Pay rent' });
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('k');
    expect(calls[0]!.body.model).toBe('claude-haiku-5-5');
    expect(calls[0]!.body.tool_choice).toEqual({ type: 'tool', name: 'file_brain_dump' });
    expect((calls[0]!.body.tools as { input_schema: { type: string } }[])[0]!.input_schema.type).toBe('object');
  });

  it('uses structured outputs for Sonnet 5.5 (no forced tool_choice)', async () => {
    const { fn, calls } = mockFetch([{
      content: [{ type: 'thinking', text: '...' }, { type: 'text', text: JSON.stringify(good) }],
      usage: { input_tokens: 20, output_tokens: 11 },
      stop_reason: 'end_turn',
    }]);
    const p = new AnthropicProvider({
      apiKey: 'k', baseUrl: 'https://api.anthropic.com',
      fastModel: 'claude-haiku-5-5', smartModel: 'claude-sonnet-5-5',
    }, fn);
    const r = await p.generateJson({ ...req, tier: 'smart' });
    expect(r.data.actions[0]).toMatchObject({ title: 'Pay rent' });
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 11 });
    expect(calls[0]!.body.model).toBe('claude-sonnet-5-5');
    expect(calls[0]!.body.tools).toBeUndefined();
    expect(calls[0]!.body.tool_choice).toBeUndefined();
    expect(calls[0]!.body.thinking).toEqual({ type: 'between_tools' });
    expect(calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(8192);
    expect((calls[0]!.init.headers as Record<string, string>)['anthropic-version']).toBe('2026-10-21');
    const cfg = calls[0]!.body.output_config as { effort: string; format: { type: string; schema: Record<string, unknown> } };
    expect(cfg.effort).toBe('low');
    expect(cfg.format.type).toBe('json_schema');
    expect(cfg.format.schema.additionalProperties).toBe(false);
  });

  it('rejects truncated structured JSON (stop_reason max_tokens)', async () => {
    const { fn } = mockFetch([{
      content: [{ type: 'text', text: '{"actions":[{"type":"create_task"' }],
      usage: {},
      stop_reason: 'max_tokens',
    }]);
    const p = new AnthropicProvider({
      apiKey: 'k', baseUrl: 'https://api.anthropic.com',
      fastModel: 'claude-haiku-5-5', smartModel: 'claude-sonnet-5-5',
    }, fn);
    await expect(p.generateJson({ ...req, tier: 'smart' })).rejects.toThrow(/max_tokens/);
  });

  it('falls back to structured outputs when forced tool_choice is rejected', async () => {
    const { fn, calls } = mockFetch([
      new Response(JSON.stringify({
        error: { message: 'tool_choice: type "tool" and "any" are not supported for this model.' },
      }), { status: 400 }),
      { content: [{ type: 'text', text: JSON.stringify(good) }], usage: { input_tokens: 9, output_tokens: 4 } },
    ]);
    const p = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com', fastModel: 'claude-mystery', smartModel: 's' }, fn);
    const r = await p.generateJson(req);
    expect(r.data.actions).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.output_config).toBeTruthy();
  });

  it('retries once with the validation error, then succeeds', async () => {
    const { fn, calls } = mockFetch([
      { content: [{ type: 'tool_use', input: { actions: [{ type: 'create_task' }] } }], usage: {} },
      { content: [{ type: 'tool_use', input: good }], usage: {} },
    ]);
    const p = new AnthropicProvider({ apiKey: 'k', baseUrl: 'https://x.test', fastModel: 'f', smartModel: 's' }, fn);
    await p.generateJson(req);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body.messages as { content: string }[])[0]!.content).toContain('failed validation');
  });

  it('surfaces API errors with the status and message', async () => {
    const { fn } = mockFetch([new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })]);
    const p = new AnthropicProvider({ apiKey: 'bad', baseUrl: 'https://api.anthropic.com', fastModel: 'f', smartModel: 's' }, fn);
    await expect(p.generateJson(req)).rejects.toThrow(/401: invalid x-api-key/);
  });

  it('sanitizes schemas and detects forced-tool support', () => {
    expect(supportsForcedToolChoice('claude-haiku-5-5')).toBe(true);
    expect(supportsForcedToolChoice('claude-sonnet-5-5')).toBe(false);
    expect(supportsForcedToolChoice('claude-opus-5-5')).toBe(false);
    const cleaned = forAnthropicStructuredSchema(jsonSchemaOf(FilerOutput));
    expect(cleaned.additionalProperties).toBe(false);
    const items = (cleaned.properties as { actions: { items: Record<string, unknown> } }).actions.items;
    expect(items.anyOf).toBeTruthy();
    expect(items.oneOf).toBeUndefined();
    const blob = JSON.stringify(cleaned);
    expect(blob).not.toMatch(/"minimum"|"minLength"|"maxItems"/);
  });
});

describe('GeminiProvider', () => {
  it('uses JSON response mode and parses fenced JSON text', async () => {
    const { fn, calls } = mockFetch([{
      candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(good) + '\n```' }] } }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9 },
    }]);
    const p = new GeminiProvider({ apiKey: 'g', baseUrl: 'https://generativelanguage.googleapis.com', fastModel: 'gemini-flash-latest', smartModel: 'gemini-flash-latest' }, fn);
    const r = await p.generateJson(req);
    expect(r.data.actions).toHaveLength(1);
    expect(calls[0]!.url).toContain('/v1beta/models/gemini-flash-latest:generateContent');
    expect((calls[0]!.body.generationConfig as { responseMimeType: string }).responseMimeType).toBe('application/json');
    expect(r.usage.inputTokens).toBe(30);
  });
});

describe('OpenAICompatProvider', () => {
  it('works without a key (local Ollama) and requires model names', async () => {
    const { fn, calls } = mockFetch([{ choices: [{ message: { content: JSON.stringify(good) } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }]);
    const p = new OpenAICompatProvider({ apiKey: null, baseUrl: 'http://localhost:11434/v1', fastModel: 'qwen', smartModel: 'qwen' }, fn);
    await p.generateJson(req);
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(() => new OpenAICompatProvider({ apiKey: null, baseUrl: 'x', fastModel: '', smartModel: '' })).toThrow(/fastModel/);
  });
});

describe('createProvider', () => {
  it('explains why it is offline', () => {
    const cfg = resolveConfig({});
    expect(createProvider(cfg, () => null).reason).toMatch(/ANTHROPIC_API_KEY/);
    expect(createProvider(cfg, () => 'k').provider?.name).toBe('anthropic');
    expect(createProvider(resolveConfig({ provider: 'offline' }), () => 'k').provider).toBeNull();
    expect(createProvider(resolveConfig({ provider: 'openai' }), () => null).reason).toMatch(/fastModel/);
  });
});

describe('helpers', () => {
  it('strips $schema and parses JSON with surrounding prose', () => {
    expect(jsonSchemaOf(FilerOutput).$schema).toBeUndefined();
    expect(parseJsonText('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  });
});
