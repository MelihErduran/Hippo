import type { RankDoc, RankHit, RankQuery, RankWeights, Ranker } from './ranker.js';

// Loads the C++ ranker compiled with wasi-sdk. The module only imports three
// WASI calls (fd_close, fd_seek, fd_write) that it never really needs, so we
// stub every import instead of shipping a WASI runtime. That keeps this loader
// identical in Node, the browser and Tauri: hand it the bytes, get a Ranker.

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  hr_alloc(n: number): number;
  hr_free(p: number): void;
  hr_reset(): void;
  hr_size(): number;
  hr_add(id: number, text: number, updated: number, due: number, project: number): void;
  hr_query(q: number, now: number, project: number, k: number, requireText: number,
    wT: number, wR: number, wU: number, wP: number): number;
}

const ENOSYS = 52;

function stubImports(mod: WebAssembly.Module): WebAssembly.Imports {
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind !== 'function') continue;
    imports[imp.module] ??= {};
    imports[imp.module]![imp.name] = imp.name === 'proc_exit'
      ? () => { throw new Error('hippo ranker called proc_exit'); }
      : () => ENOSYS;
  }
  return imports;
}

export class WasmRanker implements Ranker {
  readonly engine = 'wasm' as const;
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  private constructor(private ex: Exports) {}

  static async load(bytes: Uint8Array | ArrayBuffer): Promise<WasmRanker> {
    const buf = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
    const mod = await WebAssembly.compile(buf);
    const inst = await WebAssembly.instantiate(mod, stubImports(mod));
    const ex = inst.exports as unknown as Exports;
    for (const fn of ['hr_alloc', 'hr_free', 'hr_reset', 'hr_add', 'hr_query'] as const) {
      if (typeof ex[fn] !== 'function') throw new Error(`ranker wasm is missing export ${fn}`);
    }
    ex._initialize?.();
    return new WasmRanker(ex);
  }

  /** Copy a JS string into wasm memory as NUL-terminated UTF-8. Caller frees. */
  private str(s: string): number {
    const bytes = this.enc.encode(s);
    const ptr = this.ex.hr_alloc(bytes.length + 1);
    if (!ptr) throw new Error('ranker wasm out of memory');
    // Re-read memory.buffer after every alloc: growth detaches old views.
    const mem = new Uint8Array(this.ex.memory.buffer, ptr, bytes.length + 1);
    mem.set(bytes);
    mem[bytes.length] = 0;
    return ptr;
  }

  private readCString(ptr: number): string {
    const mem = new Uint8Array(this.ex.memory.buffer);
    let end = ptr;
    while (mem[end] !== 0) end++;
    return this.dec.decode(mem.subarray(ptr, end));
  }

  rank(docs: RankDoc[], q: RankQuery, w: RankWeights): RankHit[] {
    const ex = this.ex;
    ex.hr_reset();
    for (const d of docs) {
      const t = this.str(d.text);
      const p = this.str(d.project ?? '');
      try {
        ex.hr_add(d.id, t, d.updatedAt, d.dueAt ?? 0, p);
      } finally {
        ex.hr_free(t);
        ex.hr_free(p);
      }
    }
    const qp = this.str(q.text);
    const pp = this.str(q.project ?? '');
    let json: string;
    try {
      const out = ex.hr_query(qp, q.now, pp, q.k ?? 0, q.requireText ? 1 : 0, w.text, w.recency, w.urgency, w.project);
      json = this.readCString(out);
    } finally {
      ex.hr_free(qp);
      ex.hr_free(pp);
    }
    ex.hr_reset(); // release index memory between calls
    const rows = JSON.parse(json) as [number, number, number][];
    return rows.map(([id, score, bm25]) => ({ id, score, bm25 }));
  }
}
