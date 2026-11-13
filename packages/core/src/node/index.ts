// Node-specific wiring: files, env vars, the SQLite driver, the wasm file.
// Everything outside src/node/ is platform-neutral so the website and the
// desktop app can reuse it with their own versions of this file.

import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain, type BrainSinks } from '../brain.js';
import { resolveConfig, type Config } from '../config.js';
import { createProvider, type KeyResolver } from '../llm/factory.js';
import type { FetchLike, LlmProvider } from '../llm/provider.js';
import { TsRanker, type Ranker } from '../rank/ranker.js';
import { WasmRanker } from '../rank/wasm-ranker.js';
import { Store, type SqlDb } from '../store/store.js';
import type { Clock } from '../time.js';

export function hippoHome(): string {
  return process.env.HIPPO_HOME || join(homedir(), '.hippo');
}

export interface Paths {
  home: string;
  db: string;
  config: string;
  status: string;
  logs: string;
}

export function paths(home = hippoHome()): Paths {
  return {
    home,
    db: join(home, 'hippo.db'),
    config: join(home, 'config.json'),
    status: join(home, 'status.txt'),
    logs: join(home, 'logs'),
  };
}

export function readUserConfig(p: Paths): Record<string, unknown> {
  if (!existsSync(p.config)) return {};
  try {
    return JSON.parse(readFileSync(p.config, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Could not parse ${p.config}: ${(e as Error).message}`);
  }
}

export function writeUserConfig(p: Paths, cfg: Record<string, unknown>): void {
  mkdirSync(p.home, { recursive: true });
  writeFileSync(p.config, `${JSON.stringify(cfg, null, 2)}\n`);
  try {
    chmodSync(p.config, 0o600); // may hold API keys
  } catch { /* non-POSIX */ }
}

export function loadConfig(p: Paths): Config {
  const cfg = resolveConfig(readUserConfig(p));
  if (process.env.HIPPO_PROVIDER) cfg.provider = process.env.HIPPO_PROVIDER as Config['provider'];
  return cfg;
}

const ENV_KEYS: Record<'anthropic' | 'gemini' | 'openai', string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};

/** config apiKey, then environment, then apiKeyCommand (e.g. the macOS Keychain). */
export function nodeKeyResolver(cfg: Config): KeyResolver {
  return (provider) => {
    const pc = cfg[provider];
    if (pc.apiKey) return pc.apiKey;
    for (const env of ENV_KEYS[provider]) if (process.env[env]) return process.env[env]!;
    if (pc.apiKeyCommand) {
      try {
        const out = execSync(pc.apiKeyCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
        if (out) return out;
      } catch { /* fall through */ }
    }
    return null;
  };
}

export async function openSqlite(file: string): Promise<SqlDb> {
  mkdirSync(dirname(file), { recursive: true });
  // Dynamic import so the CLI can silence the experimental warning first.
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file) as unknown as SqlDb;
}

export function defaultWasmPath(): string {
  return fileURLToPath(new URL('../../assets/hippo_ranker.wasm', import.meta.url));
}

/** The C++ ranker if its .wasm is present and loads, else the TypeScript one. */
export async function loadRanker(wasmPath = defaultWasmPath()): Promise<Ranker> {
  if (process.env.HIPPO_RANKER === 'ts') return new TsRanker();
  try {
    if (existsSync(wasmPath)) return await WasmRanker.load(readFileSync(wasmPath));
  } catch { /* fall back */ }
  return new TsRanker();
}

/** Write only when content changed, so Obsidian does not see churn. */
export function writeIfChanged(file: string, content: string): boolean {
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return false;
  } catch { /* rewrite */ }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return true;
}

export function mirrorSink(dir: string): NonNullable<BrainSinks['mirror']> {
  return (files) => {
    for (const [rel, content] of files) writeIfChanged(join(dir, rel), content);
  };
}

export interface OpenOptions {
  home?: string;
  clock?: Clock;
  wasmPath?: string;
  /** Override the provider (tests, or a fake). `null` forces offline. */
  provider?: LlmProvider | null;
  fetchFn?: FetchLike;
  sinks?: BrainSinks;
}

export async function openBrain(o: OpenOptions = {}): Promise<{ brain: Brain; paths: Paths }> {
  const p = paths(o.home);
  mkdirSync(p.home, { recursive: true });
  const config = loadConfig(p);
  const store = new Store(await openSqlite(p.db));
  const ranker = await loadRanker(o.wasmPath);
  let provider: LlmProvider | null;
  let reason: string | null = null;
  if (o.provider !== undefined) {
    provider = o.provider;
    reason = provider ? null : 'offline (forced)';
  } else {
    const choice = createProvider(config, nodeKeyResolver(config), o.fetchFn);
    provider = choice.provider;
    reason = choice.reason;
  }
  const mirrorDir = config.mirrorDir === undefined ? join(p.home, 'mirror') : config.mirrorDir;
  const sinks: BrainSinks = { mirror: mirrorDir ? mirrorSink(mirrorDir.replace(/^~(?=\/|$)/, homedir())) : undefined, ...o.sinks };
  const brain = new Brain({ store, config, provider, providerReason: reason, ranker, clock: o.clock, sinks });
  return { brain, paths: p };
}
