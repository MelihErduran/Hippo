import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, TsRanker, type RankDoc } from '../src/rank/ranker.js';
import { tokenize } from '../src/rank/tokenize.js';
import { WasmRanker } from '../src/rank/wasm-ranker.js';

const WASM = fileURLToPath(new URL('../assets/hippo_ranker.wasm', import.meta.url));
const NOW = Date.UTC(2026, 10, 4, 22, 56);
const DAY = 86_400_000;

describe('tokenize', () => {
  it('lowercases ASCII, drops stopwords and single chars, keeps UTF-8', () => {
    expect(tokenize('Finish CS161 HW4, then email Navid!')).toEqual(['finish', 'cs161', 'hw4', 'email', 'navid']);
    expect(tokenize('Ödev: türkçe çeviri')).toEqual(['Ödev', 'türkçe', 'çeviri']);
    expect(tokenize('a b c I')).toEqual([]);
  });
});

describe('TsRanker', () => {
  const r = new TsRanker();
  it('ranks text matches and filters non-matches', () => {
    const docs: RankDoc[] = [
      { id: 1, text: 'buy groceries milk eggs', updatedAt: NOW, dueAt: null, project: null },
      { id: 2, text: 'cs161 homework four problem set', updatedAt: NOW, dueAt: null, project: 'cs161' },
      { id: 3, text: 'cs161 lecture notes on graphs', updatedAt: NOW, dueAt: null, project: 'cs161' },
    ];
    const hits = r.rank(docs, { text: 'cs161 homework', now: NOW, requireText: true }, DEFAULT_WEIGHTS);
    expect(hits.map((h) => h.id)).toEqual([2, 3]);
  });
  it('matches the exact formula from the design doc', () => {
    const one = r.rank([{ id: 7, text: 'hello world', updatedAt: NOW - 14 * DAY, dueAt: null, project: null }],
      { text: 'hello', now: NOW }, DEFAULT_WEIGHTS);
    expect(one[0]!.score).toBeCloseTo(0.55 + 0.1, 12);
  });
});

// ---- parity between the C++ (WebAssembly) engine and the TypeScript reference

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const VOCAB = ['cs161', 'homework', 'graph', 'esp32', 'wiring', 'navid', 'signalos', 'queue', 'refactor',
  'email', 'recruiter', 'epic', 'interview', 'ödev', 'türkçe', 'surf', 'groceries', 'fl', 'studio', 'diff',
  'the', 'and', 'a', 'test', 'Test', 'TEST', 'job', 'skip', 'locked', 'brief', 'mentor', 'idea'];
const PROJECTS = [null, 'cs161', 'signalos', 'smart-bin'];

function corpus(seed: number, size: number): RankDoc[] {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  return Array.from({ length: size }, (_, i) => ({
    id: i + 1,
    text: Array.from({ length: 1 + Math.floor(rand() * 12) }, () => pick(VOCAB)).join(rand() < 0.5 ? ' ' : ', '),
    updatedAt: NOW - Math.floor(rand() * 60 * DAY),
    dueAt: rand() < 0.4 ? NOW + Math.floor((rand() - 0.3) * 10 * DAY) : null,
    project: pick(PROJECTS),
  }));
}

describe.skipIf(!existsSync(WASM))('WasmRanker parity with TsRanker', () => {
  it('produces the same hits and scores on randomized corpora', async () => {
    const wasm = await WasmRanker.load(readFileSync(WASM));
    const ts = new TsRanker();
    for (let seed = 1; seed <= 60; seed++) {
      const docs = corpus(seed, 1 + (seed * 7) % 80);
      const rand = rng(seed * 31);
      const query = Array.from({ length: Math.floor(rand() * 4) }, () => VOCAB[Math.floor(rand() * VOCAB.length)]).join(' ');
      const q = { text: query, now: NOW, project: PROJECTS[seed % 4], requireText: seed % 2 === 0 };
      const a = ts.rank(docs, q, DEFAULT_WEIGHTS);
      const b = wasm.rank(docs, q, DEFAULT_WEIGHTS);
      expect(b.length).toBe(a.length);
      const byId = new Map(a.map((h) => [h.id, h]));
      for (const h of b) {
        const ref = byId.get(h.id);
        expect(ref, `seed ${seed} id ${h.id}`).toBeDefined();
        expect(Math.abs(h.score - ref!.score)).toBeLessThan(1e-9);
        expect(Math.abs(h.bm25 - ref!.bm25)).toBeLessThan(1e-9);
      }
      for (let i = 1; i < b.length; i++) expect(b[i - 1]!.score).toBeGreaterThanOrEqual(b[i]!.score - 1e-12);
    }
  });

  it('honors k and handles empty corpora and non-ASCII text', async () => {
    const wasm = await WasmRanker.load(readFileSync(WASM));
    expect(wasm.rank([], { text: 'x', now: NOW }, DEFAULT_WEIGHTS)).toEqual([]);
    const docs = corpus(99, 50);
    expect(wasm.rank(docs, { text: 'cs161', now: NOW, k: 5 }, DEFAULT_WEIGHTS)).toHaveLength(5);
    const tr = wasm.rank([{ id: 1, text: 'Ödev teslim', updatedAt: NOW, dueAt: null, project: null }],
      { text: 'ödev Ödev', now: NOW, requireText: true }, DEFAULT_WEIGHTS);
    expect(tr).toHaveLength(1); // "Ödev" matches itself; "ödev" is a different token by design
  });
});
