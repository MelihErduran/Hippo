import { z } from 'zod';
import { parseHm } from './time.js';

// Config is plain JSON at ~/.hippo/config.json. Anything missing falls back to
// these defaults, so the file only needs the keys you change.

const ProviderKeys = z.object({
  apiKey: z.string().optional(),
  /** Shell command whose stdout is the key, e.g. reading the macOS Keychain. */
  apiKeyCommand: z.string().optional(),
  baseUrl: z.string(),
  fastModel: z.string(),
  smartModel: z.string(),
});

const Block = z.object({
  days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])),
  start: z.string(),
  end: z.string(),
  label: z.string(),
});
export type ScheduleBlock = z.infer<typeof Block>;

export const ConfigSchema = z.object({
  provider: z.enum(['anthropic', 'gemini', 'openai', 'offline']),
  anthropic: ProviderKeys,
  gemini: ProviderKeys,
  openai: ProviderKeys,
  /** Folder for the markdown mirror. Empty string disables it. */
  mirrorDir: z.string().optional(),
  briefAt: z.string(),
  quietHours: z.object({ start: z.string(), end: z.string() }),
  nudges: z.object({
    enabled: z.boolean(),
    /** Durations before a deadline: "24h", "3h", "30m". */
    ladder: z.array(z.string()),
    dailyCap: z.number().int().min(0),
    /** Start nudge fires at due - estimate * startBuffer. */
    startBuffer: z.number().min(1),
  }),
  schedule: z.object({
    dayStart: z.string(),
    dayEnd: z.string(),
    /** Fixed weekly commitments: classes, shifts, standing meetings. */
    blocks: z.array(Block),
  }),
  ranker: z.object({
    weights: z.object({ text: z.number(), recency: z.number(), urgency: z.number(), project: z.number() }),
  }),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = {
  provider: 'anthropic',
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    fastModel: 'claude-haiku-5-5',
    smartModel: 'claude-sonnet-5-5',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    fastModel: 'gemini-flash-latest',
    smartModel: 'gemini-flash-latest',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    fastModel: '',
    smartModel: '',
  },
  briefAt: '07:30',
  quietHours: { start: '23:00', end: '07:00' },
  nudges: { enabled: true, ladder: ['24h', '3h', '30m'], dailyCap: 8, startBuffer: 1.5 },
  schedule: { dayStart: '07:00', dayEnd: '23:00', blocks: [] },
  ranker: { weights: { text: 0.55, recency: 0.2, urgency: 0.15, project: 0.1 } },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Merge user JSON over defaults and validate. Throws a readable error. */
export function resolveConfig(user: unknown): Config {
  const merged = deepMerge(DEFAULT_CONFIG, user ?? {});
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }
  const c = parsed.data;
  // Fail early on time strings so a typo does not silently break nudges.
  for (const hm of [c.briefAt, c.quietHours.start, c.quietHours.end, c.schedule.dayStart, c.schedule.dayEnd]) {
    parseHm(hm);
  }
  for (const b of c.schedule.blocks) {
    parseHm(b.start);
    parseHm(b.end);
  }
  for (const l of c.nudges.ladder) parseDurationMs(l);
  return c;
}

/** "24h" | "30m" | "2d" -> ms */
export function parseDurationMs(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`Bad duration "${s}" (use like 30m, 3h, 2d)`);
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
}

/** Set a dotted key ("nudges.dailyCap") on a plain object, returning a copy. */
export function setDotted(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const parts = key.split('.');
  const out: Record<string, unknown> = structuredClone(obj);
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isObj(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
  return out;
}

export function getDotted(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const p of key.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}
