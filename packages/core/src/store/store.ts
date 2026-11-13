import type {
  ActionRow, ActionType, BriefContent, Capture, Checkpoint, Item, ItemKind, ItemStatus, Project,
} from '../types.js';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';

// The store is the only module that writes SQL. It takes any database object
// with the node:sqlite / better-sqlite3 shape, so the driver can be swapped
// (and the website can move to Postgres by reimplementing this one class).

export type SqlValue = string | number | bigint | null | Uint8Array;
export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}
export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close?(): void;
}

type Row = Record<string, unknown>;
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const v = (x: unknown): SqlValue => (x === undefined ? null : (x as SqlValue));

function toItem(r: Row): Item {
  return {
    id: Number(r.id),
    kind: r.kind as ItemKind,
    title: String(r.title),
    body: s(r.body),
    projectId: n(r.project_id),
    status: r.status as ItemStatus,
    dueAt: n(r.due_at),
    remindAt: n(r.remind_at),
    snoozedUntil: n(r.snoozed_until),
    estimateMin: n(r.estimate_min),
    captureId: n(r.capture_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    completedAt: n(r.completed_at),
  };
}
function toProject(r: Row): Project {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    name: String(r.name),
    createdAt: Number(r.created_at),
    lastTouchedAt: Number(r.last_touched_at),
  };
}
function toCheckpoint(r: Row): Checkpoint {
  return {
    id: Number(r.id),
    projectId: Number(r.project_id),
    summary: String(r.summary),
    nextStep: s(r.next_step),
    captureId: n(r.capture_id),
    createdAt: Number(r.created_at),
  };
}
function toCapture(r: Row): Capture {
  return {
    id: Number(r.id),
    text: String(r.text),
    source: String(r.source),
    createdAt: Number(r.created_at),
    processedAt: n(r.processed_at),
    error: s(r.error),
  };
}
function toAction(r: Row): ActionRow {
  return {
    id: Number(r.id),
    batch: String(r.batch),
    agent: String(r.agent),
    type: r.type as ActionType,
    targetId: Number(r.target_id),
    payload: JSON.parse(String(r.payload)),
    before: r.before === null ? null : JSON.parse(String(r.before)),
    createdAt: Number(r.created_at),
    undoneAt: n(r.undone_at),
  };
}

/** Column names for item fields that may be updated. */
const ITEM_COLUMNS: Record<string, string> = {
  kind: 'kind',
  title: 'title',
  body: 'body',
  projectId: 'project_id',
  status: 'status',
  dueAt: 'due_at',
  remindAt: 'remind_at',
  snoozedUntil: 'snoozed_until',
  estimateMin: 'estimate_min',
  completedAt: 'completed_at',
};
export type ItemPatch = Partial<Pick<Item,
  'kind' | 'title' | 'body' | 'projectId' | 'status' | 'dueAt' | 'remindAt' | 'snoozedUntil' | 'estimateMin' | 'completedAt'>>;

export type NewItem = Omit<Item, 'id' | 'updatedAt' | 'completedAt' | 'status' | 'snoozedUntil'> &
  Partial<Pick<Item, 'status' | 'snoozedUntil'>>;

export class Store {
  private stmts = new Map<string, SqlStatement>();
  private depth = 0;

  constructor(private db: SqlDb) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private q(sql: string): SqlStatement {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.q(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as Row | undefined;
    let current = row ? Number(row.value) : 0;
    while (current < SCHEMA_VERSION) {
      const next = current + 1;
      this.tx(() => {
        this.db.exec(MIGRATIONS[next]!);
        this.q(`INSERT INTO meta(key, value) VALUES('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
      });
      current = next;
    }
  }

  /** Run fn in a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close?.();
  }

  // ---- meta
  getMeta(key: string): string | null {
    const r = this.q('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }
  setMeta(key: string, value: string): void {
    this.q(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  // ---- captures
  addCapture(text: string, source: string, now: number): number {
    const r = this.q('INSERT INTO captures(text, source, created_at) VALUES(?, ?, ?)').run(text, source, now);
    return Number(r.lastInsertRowid);
  }
  getCapture(id: number): Capture | null {
    const r = this.q('SELECT * FROM captures WHERE id = ?').get(id) as Row | undefined;
    return r ? toCapture(r) : null;
  }
  markCapture(id: number, now: number, error: string | null): void {
    this.q('UPDATE captures SET processed_at = ?, error = ? WHERE id = ?').run(error ? null : now, error, id);
  }
  unprocessedCaptures(limit = 10): Capture[] {
    return (this.q('SELECT * FROM captures WHERE processed_at IS NULL ORDER BY id LIMIT ?').all(limit) as Row[])
      .map(toCapture);
  }
  recentCaptures(limit: number): Capture[] {
    return (this.q('SELECT * FROM captures ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toCapture);
  }

  // ---- projects
  listProjects(): Project[] {
    return (this.q('SELECT * FROM projects ORDER BY last_touched_at DESC').all() as Row[]).map(toProject);
  }
  getProject(id: number): Project | null {
    const r = this.q('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? toProject(r) : null;
  }
  projectBySlug(slug: string): Project | null {
    const r = this.q('SELECT * FROM projects WHERE slug = ?').get(slug) as Row | undefined;
    return r ? toProject(r) : null;
  }
  insertProject(slug: string, name: string, now: number): Project {
    const r = this.q('INSERT INTO projects(slug, name, created_at, last_touched_at) VALUES(?, ?, ?, ?)')
      .run(slug, name, now, now);
    return this.getProject(Number(r.lastInsertRowid))!;
  }
  touchProject(id: number, now: number): void {
    this.q('UPDATE projects SET last_touched_at = MAX(last_touched_at, ?) WHERE id = ?').run(now, id);
  }
  setProjectTouched(id: number, at: number): void {
    this.q('UPDATE projects SET last_touched_at = ? WHERE id = ?').run(at, id);
  }
  deleteProject(id: number): void {
    this.q('DELETE FROM projects WHERE id = ?').run(id);
  }
  projectInUse(id: number): boolean {
    const a = this.q('SELECT 1 FROM items WHERE project_id = ? LIMIT 1').get(id);
    const b = this.q('SELECT 1 FROM checkpoints WHERE project_id = ? LIMIT 1').get(id);
    return Boolean(a || b);
  }
  projectOpenCounts(): Map<number, number> {
    const rows = this.q(`SELECT project_id, COUNT(*) AS c FROM items
                         WHERE status = 'open' AND kind = 'task' AND project_id IS NOT NULL
                         GROUP BY project_id`).all() as Row[];
    return new Map(rows.map((r) => [Number(r.project_id), Number(r.c)]));
  }

  // ---- items
  insertItem(it: NewItem, now: number): Item {
    const r = this.q(`INSERT INTO items(kind, title, body, project_id, status, due_at, remind_at, snoozed_until,
                        estimate_min, capture_id, created_at, updated_at)
                      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      it.kind, it.title, v(it.body), v(it.projectId), it.status ?? 'open', v(it.dueAt), v(it.remindAt),
      v(it.snoozedUntil), v(it.estimateMin), v(it.captureId), it.createdAt, now,
    );
    return this.getItem(Number(r.lastInsertRowid))!;
  }
  getItem(id: number): Item | null {
    const r = this.q('SELECT * FROM items WHERE id = ?').get(id) as Row | undefined;
    return r ? toItem(r) : null;
  }
  updateItem(id: number, patch: ItemPatch, now: number): void {
    const cols: string[] = [];
    const vals: SqlValue[] = [];
    for (const [k, val] of Object.entries(patch)) {
      const col = ITEM_COLUMNS[k];
      if (!col) throw new Error(`Unknown item field ${k}`);
      cols.push(`${col} = ?`);
      vals.push(v(val));
    }
    if (cols.length === 0) return;
    cols.push('updated_at = ?');
    vals.push(now, id);
    this.db.prepare(`UPDATE items SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  }
  deleteItem(id: number): void {
    this.q('DELETE FROM nudges WHERE item_id = ?').run(id);
    this.q('DELETE FROM items WHERE id = ?').run(id);
  }
  openTasks(): Item[] {
    return (this.q(`SELECT * FROM items WHERE status = 'open' AND kind = 'task'
                    ORDER BY due_at IS NULL, due_at, id`).all() as Row[]).map(toItem);
  }
  allItems(): Item[] {
    return (this.q('SELECT * FROM items ORDER BY id').all() as Row[]).map(toItem);
  }
  itemsByProject(projectId: number): Item[] {
    return (this.q('SELECT * FROM items WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Row[])
      .map(toItem);
  }
  itemsByKind(kind: ItemKind): Item[] {
    return (this.q('SELECT * FROM items WHERE kind = ? ORDER BY created_at DESC').all(kind) as Row[]).map(toItem);
  }
  completedSince(ms: number): Item[] {
    return (this.q(`SELECT * FROM items WHERE status = 'done' AND completed_at >= ? ORDER BY completed_at DESC`)
      .all(ms) as Row[]).map(toItem);
  }
  counts(): Record<string, number> {
    const r = this.q(`SELECT
        (SELECT COUNT(*) FROM items WHERE kind = 'task' AND status = 'open') AS open_tasks,
        (SELECT COUNT(*) FROM items) AS items,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM captures) AS captures,
        (SELECT COUNT(*) FROM checkpoints) AS checkpoints`).get() as Row;
    return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, Number(x)]));
  }

  // ---- checkpoints
  insertCheckpoint(projectId: number, summary: string, nextStep: string | null, captureId: number | null, now: number): Checkpoint {
    const r = this.q(`INSERT INTO checkpoints(project_id, summary, next_step, capture_id, created_at)
                      VALUES(?, ?, ?, ?, ?)`).run(projectId, summary, nextStep, captureId, now);
    return this.getCheckpoint(Number(r.lastInsertRowid))!;
  }
  getCheckpoint(id: number): Checkpoint | null {
    const r = this.q('SELECT * FROM checkpoints WHERE id = ?').get(id) as Row | undefined;
    return r ? toCheckpoint(r) : null;
  }
  deleteCheckpoint(id: number): void {
    this.q('DELETE FROM checkpoints WHERE id = ?').run(id);
  }
  checkpointsFor(projectId: number, limit: number): Checkpoint[] {
    return (this.q('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(projectId, limit) as Row[]).map(toCheckpoint);
  }
  latestCheckpoint(): Checkpoint | null {
    const r = this.q('SELECT * FROM checkpoints ORDER BY created_at DESC, id DESC LIMIT 1').get() as Row | undefined;
    return r ? toCheckpoint(r) : null;
  }

  // ---- action log
  logAction(batch: string, agent: string, type: ActionType, targetId: number, payload: unknown, before: unknown, now: number): void {
    this.q(`INSERT INTO actions(batch, agent, type, target_id, payload, before, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
      batch, agent, type, targetId, JSON.stringify(payload ?? null), before === undefined ? null : JSON.stringify(before), now,
    );
  }
  lastActiveBatch(): string | null {
    const r = this.q('SELECT batch FROM actions WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    return r ? String(r.batch) : null;
  }
  actionsForBatch(batch: string): ActionRow[] {
    return (this.q('SELECT * FROM actions WHERE batch = ? AND undone_at IS NULL ORDER BY id').all(batch) as Row[])
      .map(toAction);
  }
  markUndone(id: number, now: number): void {
    this.q('UPDATE actions SET undone_at = ? WHERE id = ?').run(now, id);
  }
  undoStats(sinceMs: number): { batches: number; undone: number } {
    const r = this.q(`SELECT COUNT(DISTINCT batch) AS b,
                             COUNT(DISTINCT CASE WHEN undone_at IS NOT NULL THEN batch END) AS u
                      FROM actions WHERE created_at >= ? AND batch LIKE 'capture:%'`).get(sinceMs) as Row;
    return { batches: Number(r.b), undone: Number(r.u) };
  }

  // ---- nudges
  nudgeRecorded(itemId: number, step: string, scheduledFor: number): boolean {
    return Boolean(this.q('SELECT 1 FROM nudges WHERE item_id = ? AND step = ? AND scheduled_for = ?')
      .get(itemId, step, scheduledFor));
  }
  recordNudge(itemId: number, step: string, scheduledFor: number, status: 'sent' | 'skipped', now: number): void {
    this.q(`INSERT OR IGNORE INTO nudges(item_id, step, scheduled_for, status, at) VALUES(?, ?, ?, ?, ?)`)
      .run(itemId, step, scheduledFor, status, now);
  }
  nudgesSentSince(ms: number): number {
    const r = this.q(`SELECT COUNT(*) AS c FROM nudges WHERE status = 'sent' AND at >= ?`).get(ms) as Row;
    return Number(r.c);
  }

  // ---- briefs
  getBrief(date: string): (BriefContent & { notified: boolean }) | null {
    const r = this.q('SELECT content, notified FROM briefs WHERE date = ?').get(date) as Row | undefined;
    return r ? { ...(JSON.parse(String(r.content)) as BriefContent), notified: Number(r.notified) === 1 } : null;
  }
  putBrief(b: BriefContent, now: number): void {
    this.q(`INSERT INTO briefs(date, content, created_at) VALUES(?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET content = excluded.content, created_at = excluded.created_at`)
      .run(b.date, JSON.stringify(b), now);
  }
  markBriefNotified(date: string): void {
    this.q('UPDATE briefs SET notified = 1 WHERE date = ?').run(date);
  }

  // ---- llm usage
  logLlmCall(c: { agent: string; provider: string; model: string; inputTokens: number; outputTokens: number; ms: number; ok: boolean; error?: string | null }, now: number): void {
    this.q(`INSERT INTO llm_calls(agent, provider, model, input_tokens, output_tokens, ms, ok, error, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      c.agent, c.provider, c.model, c.inputTokens, c.outputTokens, Math.round(c.ms), c.ok ? 1 : 0, c.error ?? null, now,
    );
  }
  llmUsage(sinceMs: number): { model: string; calls: number; inputTokens: number; outputTokens: number; failures: number }[] {
    return (this.q(`SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
                           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS f
                    FROM llm_calls WHERE created_at >= ? GROUP BY model ORDER BY calls DESC`).all(sinceMs) as Row[])
      .map((r) => ({
        model: String(r.model), calls: Number(r.calls), inputTokens: Number(r.i ?? 0),
        outputTokens: Number(r.o ?? 0), failures: Number(r.f ?? 0),
      }));
  }
}
