import { tokenize } from './tokenize.js';

export interface RankDoc {
  id: number;
  text: string;
  updatedAt: number;
  dueAt: number | null;
  project: string | null;
}

export interface RankQuery {
  text: string;
  now: number;
  project?: string | null;
  /** 0 or undefined returns every hit. */
  k?: number;
  /** Drop docs that match no query term (only when the query has tokens). */
  requireText?: boolean;
}

export interface RankWeights {
  text: number;
  recency: number;
  urgency: number;
  project: number;
}

export interface RankHit {
  id: number;
  score: number;
  /** Raw BM25 before normalization; 0 means no query term matched. */
  bm25: number;
}

export interface Ranker {
  readonly engine: 'wasm' | 'ts';
  rank(docs: RankDoc[], q: RankQuery, weights: RankWeights): RankHit[];
}

export const DEFAULT_WEIGHTS: RankWeights = { text: 0.55, recency: 0.2, urgency: 0.15, project: 0.1 };

const K1 = 1.2;
const B = 0.75;
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const RECENCY_HALF_LIFE_DAYS = 14;
const URGENCY_HALF_LIFE_HOURS = 48;

/** Reference implementation. The C++ engine must produce the same numbers. */
export class TsRanker implements Ranker {
  readonly engine = 'ts' as const;

  rank(docs: RankDoc[], q: RankQuery, w: RankWeights): RankHit[] {
    const n = docs.length;
    if (n === 0) return [];
    const terms: string[] = [];
    const seen = new Set<string>();
    for (const t of tokenize(q.text)) {
      if (!seen.has(t)) {
        seen.add(t);
        terms.push(t);
      }
    }

    const tfs: Map<string, number>[] = [];
    const lens: number[] = [];
    const df = new Map<string, number>();
    let totalLen = 0;
    for (const d of docs) {
      const tokens = tokenize(d.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      tfs.push(tf);
      lens.push(tokens.length);
      totalLen += tokens.length;
    }

    const avgdl = totalLen / n;
    const bm = new Array<number>(n).fill(0);
    let maxBm = 0;
    for (let i = 0; i < n; i++) {
      const tf = tfs[i]!;
      let s = 0;
      for (const term of terms) {
        const f = tf.get(term);
        if (f === undefined) continue;
        const dfv = df.get(term) ?? 0;
        const idf = Math.log(1 + (n - dfv + 0.5) / (dfv + 0.5));
        const norm = avgdl > 0 ? lens[i]! / avgdl : 0;
        s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * norm));
      }
      bm[i] = s;
      if (s > maxBm) maxBm = s;
    }

    const hits: RankHit[] = [];
    for (let i = 0; i < n; i++) {
      const d = docs[i]!;
      if (q.requireText && terms.length > 0 && bm[i]! <= 0) continue;
      const text = maxBm > 0 ? bm[i]! / maxBm : 0;
      const ageDays = Math.max(0, q.now - d.updatedAt) / MS_PER_DAY;
      const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
      let urgency = 0;
      const due = d.dueAt ?? 0;
      if (due > 0) {
        const hoursLeft = (due - q.now) / MS_PER_HOUR;
        urgency = hoursLeft <= 0 ? 1 : Math.pow(0.5, hoursLeft / URGENCY_HALF_LIFE_HOURS);
      }
      const proj = q.project && d.project === q.project ? 1 : 0;
      const score = w.text * text + w.recency * recency + w.urgency * urgency + w.project * proj;
      hits.push({ id: d.id, score, bm25: bm[i]! });
    }
    hits.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.id - b.id));
    return q.k && q.k > 0 ? hits.slice(0, q.k) : hits;
  }
}
