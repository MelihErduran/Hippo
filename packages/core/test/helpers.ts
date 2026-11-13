import { DatabaseSync } from 'node:sqlite';
import { Brain } from '../src/brain.js';
import { resolveConfig, type Config } from '../src/config.js';
import type { JsonRequest, JsonResult, LlmProvider, Tier } from '../src/llm/provider.js';
import { TsRanker } from '../src/rank/ranker.js';
import { Store, type SqlDb } from '../src/store/store.js';

/** Wed Nov 4 2026, 2:56 PM local (America/Los_Angeles). */
export const T0 = new Date(2026, 10, 4, 14, 56).getTime();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export class FakeClock {
  constructor(public t = T0) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
  set(d: Date) {
    this.t = d.getTime();
  }
}

/** A provider that replays scripted responses (or throws scripted errors). */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  calls: JsonRequest<unknown>[] = [];
  constructor(private script: (unknown | Error)[] = []) {}
  push(x: unknown | Error) {
    this.script.push(x);
  }
  modelFor(tier: Tier) {
    return `fake-${tier}`;
  }
  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    this.calls.push(req as JsonRequest<unknown>);
    const next = this.script.shift();
    if (next === undefined) throw new Error('FakeProvider: script exhausted');
    if (next instanceof Error) throw next;
    const data = req.schema.parse(next);
    return { data, usage: { inputTokens: 100, outputTokens: 50 }, model: this.modelFor(req.tier), provider: this.name, ms: 5 };
  }
}

export function memoryStore(): Store {
  return new Store(new DatabaseSync(':memory:') as unknown as SqlDb);
}

export function makeBrain(opts: { provider?: LlmProvider | null; clock?: FakeClock; config?: unknown; store?: Store } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const store = opts.store ?? memoryStore();
  const config: Config = resolveConfig(opts.config ?? {});
  const mirror = new Map<string, string>();
  const brain = new Brain({
    store,
    config,
    provider: opts.provider ?? null,
    providerReason: opts.provider ? null : 'test: offline',
    ranker: new TsRanker(),
    clock: clock.now,
    sinks: { mirror: (files) => { mirror.clear(); for (const [k, v] of files) mirror.set(k, v); } },
  });
  return { brain, store, clock, mirror };
}
