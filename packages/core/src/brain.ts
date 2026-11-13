import { applyActions, matchProject, resolveFilerActions, undoLast, type ResolvedAction, type UndoResult } from './agents/actions.js';
import { fileWithModel, type FilerContext } from './agents/filer.js';
import { fileOffline } from './agents/filer-offline.js';
import { dayShape, normalizePlan, planOffline, planWithModel, plannerCandidates, type PlannerContext } from './agents/planner.js';
import { normalizeRecall, recallOffline, recallWithModel, type RecallContext } from './agents/recall.js';
import type { FilerOutput } from './agents/schemas.js';
import { parseDurationMs, type Config } from './config.js';
import type { JsonResult, LlmProvider, Tier } from './llm/provider.js';
import { renderMirror } from './mirror/markdown.js';
import { inQuietHours, planNudges, type Nudge, type NudgePolicy } from './nudge/policy.js';
import type { RankDoc, Ranker } from './rank/ranker.js';
import { tokenize } from './rank/tokenize.js';
import type { Store } from './store/store.js';
import { DAY, HOUR, localDateKey, localMinutes, parseHm, startOfLocalDay, systemClock, type Clock } from './time.js';
import type { Applied, BriefContent, Checkpoint, Item, Project, RecallResult } from './types.js';
import { capitalize, slugify } from './util.js';

// The Brain is the only API surfaces call. The CLI uses it today; a web API
// route or a Tauri command will call the same methods later.

export interface Notification {
  title: string;
  subtitle?: string;
  body: string;
}
export type Notifier = (n: Notification) => Promise<boolean>;

export interface StatusSummary {
  next: { id: number; title: string; dueAt: number } | null;
  overdue: number;
  openTasks: number;
  briefReady: boolean;
  last: { project: string; text: string } | null;
  now: number;
}

export interface BrainSinks {
  /** Receives mirror files (relative path -> content) after every change. */
  mirror?: (files: Map<string, string>) => void;
  /** Receives the status summary after every change (for the terminal greeting). */
  status?: (s: StatusSummary) => void;
}

export interface BrainOptions {
  store: Store;
  config: Config;
  provider: LlmProvider | null;
  /** Why there is no provider, if there is none. */
  providerReason?: string | null;
  ranker: Ranker;
  clock?: Clock;
  sinks?: BrainSinks;
}

export interface CaptureResult {
  captureId: number;
  batch: string;
  applied: Applied[];
  warnings: string[];
  reply: string | null;
  source: 'model' | 'offline';
  /** Set when offline filing was used, explaining why. */
  fallbackReason: string | null;
}

export type DoneResult =
  | { status: 'done'; item: Item }
  | { status: 'ambiguous'; candidates: Item[] }
  | { status: 'none' };

export interface TaskGroups {
  overdue: Item[];
  today: Item[];
  week: Item[];
  later: Item[];
  someday: Item[];
}

export interface TickResult {
  processed: number;
  briefGenerated: boolean;
  briefNotified: boolean;
  sent: Nudge[];
  skipped: Nudge[];
  held: Nudge[];
}

const NEXT_SPLIT = /,?\s*(?:next is|next step is|next step:|next:|then next|→|->)\s*/i;

export class Brain {
  readonly store: Store;
  readonly config: Config;
  readonly provider: LlmProvider | null;
  readonly providerReason: string | null;
  readonly ranker: Ranker;
  private clock: Clock;
  private sinks: BrainSinks;

  constructor(o: BrainOptions) {
    this.store = o.store;
    this.config = o.config;
    this.provider = o.provider;
    this.providerReason = o.provider ? null : o.providerReason ?? 'no model provider configured';
    this.ranker = o.ranker;
    this.clock = o.clock ?? systemClock;
    this.sinks = o.sinks ?? {};
  }

  now(): number {
    return this.clock();
  }

  // ---------------------------------------------------------------- helpers

  private slugMap(): Map<number, string> {
    return new Map(this.store.listProjects().map((p) => [p.id, p.slug]));
  }

  private docs(items: Item[], slugs: Map<number, string>): RankDoc[] {
    return items.map((i) => {
      const project = i.projectId === null ? null : slugs.get(i.projectId) ?? null;
      return { id: i.id, text: `${i.title} ${i.body ?? ''} ${project ?? ''}`, updatedAt: i.updatedAt, dueAt: i.status === 'open' ? i.dueAt : null, project };
    });
  }

  /** Rank items with the configured weights. */
  rankItems(items: Item[], text: string, opts: { project?: string | null; k?: number; requireText?: boolean } = {}) {
    const slugs = this.slugMap();
    const byId = new Map(items.map((i) => [i.id, i]));
    return this.ranker
      .rank(this.docs(items, slugs), { text, now: this.now(), ...opts }, this.config.ranker.weights)
      .map((h) => ({ ...h, item: byId.get(h.id)! }));
  }

  private async callModel<T>(agent: string, tier: Tier, fn: (p: LlmProvider) => Promise<JsonResult<T>>): Promise<T> {
    const p = this.provider!;
    const started = Date.now();
    try {
      const r = await fn(p);
      this.store.logLlmCall({ agent, provider: r.provider, model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, ms: r.ms, ok: true }, this.now());
      return r.data;
    } catch (e) {
      this.store.logLlmCall({ agent, provider: p.name, model: p.modelFor(tier), inputTokens: 0, outputTokens: 0, ms: Date.now() - started, ok: false, error: (e as Error).message }, this.now());
      throw e;
    }
  }

  /** Regenerate the markdown mirror and the status cache. Never throws. */
  refresh(): void {
    try {
      this.sinks.mirror?.(renderMirror(this.store, this.now()));
    } catch { /* the mirror is a convenience; never block a capture on it */ }
    try {
      this.sinks.status?.(this.status());
    } catch { /* same */ }
  }

  private commandBatch(name: string): string {
    return `cmd:${name}:${this.now()}:${Math.random().toString(36).slice(2, 6)}`;
  }

  // ---------------------------------------------------------------- capture

  async capture(text: string, source = 'cli'): Promise<CaptureResult> {
    const dump = text.trim();
    if (!dump) throw new Error('Nothing to capture.');
    // Saved before any model call: a dump is never lost.
    const captureId = this.store.addCapture(dump, source, this.now());
    return this.fileCapture(captureId);
  }

  private async fileCapture(captureId: number): Promise<CaptureResult> {
    const capture = this.store.getCapture(captureId);
    if (!capture) throw new Error(`No capture #${captureId}`);
    const now = this.now();
    const slugs = this.slugMap();
    const projectOf = (item: { projectId: number | null }) =>
      item.projectId === null ? null : slugs.get(item.projectId) ?? null;
    const relevant = this.rankItems(this.store.openTasks(), capture.text, { k: 25 })
      .map((h) => ({ item: h.item, project: projectOf(h.item) }));
    const taskById = new Map(relevant.map((t) => [t.item.id, t]));
    const openNotesPool = this.store.allItems().filter((i) =>
      (i.kind === 'note' || i.kind === 'idea') && i.status === 'open');
    const noteHits = this.rankItems(openNotesPool, capture.text, { k: 15 })
      .map((h) => ({ item: h.item, project: projectOf(h.item) }));
    const noteById = new Map(noteHits.map((n) => [n.item.id, n]));
    for (const m of capture.text.matchAll(/#(\d+)/g)) {
      const id = Number(m[1]);
      if (!taskById.has(id)) {
        const it = this.store.getItem(id);
        if (it && it.kind === 'task' && it.status === 'open') {
          taskById.set(id, { item: it, project: projectOf(it) });
        }
      }
      if (!noteById.has(id)) {
        const it = this.store.getItem(id);
        if (it && (it.kind === 'note' || it.kind === 'idea') && it.status === 'open') {
          noteById.set(id, { item: it, project: projectOf(it) });
        }
      }
    }
    const ctx: FilerContext = {
      now, dump: capture.text, projects: this.store.listProjects(),
      openTasks: [...taskById.values()], openNotes: [...noteById.values()],
    };

    let output: FilerOutput;
    let source: 'model' | 'offline' = 'offline';
    let fallbackReason: string | null = null;
    if (this.provider) {
      try {
        output = await this.callModel('filer', 'fast', (p) => fileWithModel(p, ctx));
        source = 'model';
      } catch (e) {
        fallbackReason = (e as Error).message;
        output = fileOffline(capture.text, { ...ctx, ranker: this.ranker });
      }
    } else {
      fallbackReason = this.providerReason;
      output = fileOffline(capture.text, { ...ctx, ranker: this.ranker });
    }

    try {
      const { actions, warnings } = resolveFilerActions(this.store, output.actions, now);
      if (actions.length === 0) {
        // Never drop a dump: keep it as a note if nothing else came out of it.
        actions.push({ type: 'create_item', kind: 'note', title: capitalize(capture.text).slice(0, 120), body: capture.text.length > 120 ? capture.text : null, project: null, dueAt: null, remindAt: null, estimateMin: null });
      }
      const batch = `capture:${captureId}`;
      const applied = applyActions(this.store, batch, source === 'model' ? 'filer' : 'filer-offline', captureId, actions, now);
      this.store.markCapture(captureId, now, null);
      this.refresh();
      return { captureId, batch, applied, warnings, reply: output.reply ?? null, source, fallbackReason };
    } catch (e) {
      this.store.markCapture(captureId, now, (e as Error).message);
      throw e;
    }
  }

  /** Retry dumps that failed to file earlier. */
  async processPending(): Promise<number> {
    let n = 0;
    for (const c of this.store.unprocessedCaptures(5)) {
      if (this.now() - c.createdAt > 2 * DAY) continue;
      try {
        await this.fileCapture(c.id);
        n++;
      } catch { /* stays unprocessed */ }
    }
    return n;
  }

  // ---------------------------------------------------------------- brief

  private plannerContext(): PlannerContext {
    const now = this.now();
    const slugs = this.slugMap();
    const candidates = plannerCandidates(this.store.openTasks(), now);
    const yesterday = this.store.getBrief(localDateKey(now - DAY));
    const openIds = new Set(candidates.map((c) => c.id));
    const checkpoints: { checkpoint: Checkpoint; project: string }[] = [];
    for (const p of this.store.listProjects().slice(0, 3)) {
      const cp = this.store.checkpointsFor(p.id, 1)[0];
      if (cp && now - cp.createdAt < 14 * DAY) checkpoints.push({ checkpoint: cp, project: p.slug });
    }
    return {
      now,
      config: this.config,
      shape: dayShape(this.config, now),
      tasks: candidates.map((item) => ({ item, project: item.projectId === null ? null : slugs.get(item.projectId) ?? null })),
      checkpoints,
      carryOver: (yesterday?.top3 ?? []).map((p) => p.taskId).filter((id) => openIds.has(id)),
    };
  }

  async today(opts: { fresh?: boolean } = {}): Promise<BriefContent> {
    const date = localDateKey(this.now());
    const existing = this.store.getBrief(date);
    if (existing && !opts.fresh) return existing;
    const ctx = this.plannerContext();
    let brief: BriefContent;
    if (this.provider && ctx.tasks.length > 0) {
      try {
        const out = await this.callModel('planner', 'smart', (p) => planWithModel(p, ctx));
        brief = normalizePlan(out, ctx, 'model');
      } catch {
        brief = planOffline(ctx);
      }
    } else {
      brief = planOffline(ctx);
    }
    this.store.putBrief(brief, this.now());
    this.refresh();
    return brief;
  }

  // ---------------------------------------------------------------- recall

  resolveProject(query?: string): Project | null {
    const projects = this.store.listProjects();
    if (!query || !query.trim()) return projects[0] ?? null;
    const direct = matchProject(projects, query);
    if (direct) return direct;
    const q = slugify(query);
    const partial = projects.find((p) => p.slug.includes(q) || p.name.toLowerCase().includes(query.toLowerCase()));
    if (partial) return partial;
    // Fall back to whichever project the best-matching items belong to.
    const hits = this.rankItems(this.store.allItems(), query, { requireText: true, k: 8 });
    const votes = new Map<number, number>();
    for (const h of hits) if (h.item.projectId !== null) votes.set(h.item.projectId, (votes.get(h.item.projectId) ?? 0) + h.score);
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? this.store.getProject(best[0]) : null;
  }

  async where(query?: string): Promise<RecallResult> {
    const project = this.resolveProject(query);
    if (!project) {
      return {
        project: null, lastTouchedAt: null, nextStep: null, openLoops: [], note: null, source: 'offline',
        lastState: query ? `No project matches "${query}".` : 'No projects yet. Dump something first.',
      };
    }
    const now = this.now();
    const items = this.store.itemsByProject(project.id);
    const needle = [project.slug, project.name.toLowerCase()];
    const ctx: RecallContext = {
      now,
      project,
      checkpoints: this.store.checkpointsFor(project.id, 5),
      openTasks: items.filter((i) => i.kind === 'task' && i.status === 'open'),
      recentItems: items.filter((i) => !(i.kind === 'task' && i.status === 'open')).slice(0, 8),
      recentDumps: this.store.recentCaptures(60).filter((c) => needle.some((n) => c.text.toLowerCase().includes(n))).slice(0, 5),
    };
    if (this.provider) {
      try {
        const out = await this.callModel('recall', 'smart', (p) => recallWithModel(p, ctx));
        return normalizeRecall(out, ctx, 'model');
      } catch { /* fall through */ }
    }
    return recallOffline(ctx);
  }

  /** Save where you are on a project. "signalos: did X, next: Y" or with an explicit project. */
  park(text: string, projectHint?: string): Applied[] {
    let body = text.trim();
    let projectName = projectHint ?? null;
    const prefix = /^#?([\p{L}\p{N}_-]{1,40}):\s+(.+)$/u.exec(body);
    if (!projectName && prefix) {
      projectName = prefix[1]!;
      body = prefix[2]!;
    }
    const project = projectName ? null : this.store.listProjects()[0] ?? null;
    if (!projectName && !project) throw new Error('Which project? Use: hippo park "project: where you are"');
    const [summary, ...rest] = body.split(NEXT_SPLIT);
    const next = rest.join(' ').trim();
    const projects = this.store.listProjects();
    const ref = projectName
      ? (matchProject(projects, projectName) ? { id: matchProject(projects, projectName)!.id } : { newSlug: slugify(projectName), name: projectName })
      : { id: project!.id };
    const applied = applyActions(this.store, this.commandBatch('park'), 'user', null, [{
      type: 'create_checkpoint', project: ref, summary: capitalize((summary ?? body).trim()), nextStep: next ? capitalize(next) : null,
    }], this.now());
    this.refresh();
    return applied;
  }

  // ---------------------------------------------------------------- tasks

  tasks(): TaskGroups {
    const now = this.now();
    const endToday = startOfLocalDay(now) + DAY;
    const g: TaskGroups = { overdue: [], today: [], week: [], later: [], someday: [] };
    for (const t of this.store.openTasks()) {
      if (t.dueAt === null) g.someday.push(t);
      else if (t.dueAt < now) g.overdue.push(t);
      else if (t.dueAt < endToday) g.today.push(t);
      else if (t.dueAt < now + 7 * DAY) g.week.push(t);
      else g.later.push(t);
    }
    // Keep same-project tasks adjacent within each due bucket.
    const byProject = (a: Item, b: Item) => {
      const sa = this.projectSlug(a.projectId) ?? '\uffff';
      const sb = this.projectSlug(b.projectId) ?? '\uffff';
      if (sa !== sb) return sa < sb ? -1 : 1;
      if (a.dueAt !== null && b.dueAt !== null && a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
      if (a.dueAt === null && b.dueAt !== null) return 1;
      if (a.dueAt !== null && b.dueAt === null) return -1;
      return a.id - b.id;
    };
    g.overdue.sort(byProject);
    g.today.sort(byProject);
    g.week.sort(byProject);
    g.later.sort(byProject);
    g.someday.sort(byProject);
    return g;
  }

  projectSlug(id: number | null): string | null {
    return id === null ? null : this.store.getProject(id)?.slug ?? null;
  }

  done(ref: string): DoneResult {
    const r = ref.trim();
    const idMatch = /^#?(\d+)$/.exec(r);
    let target: Item | null = null;
    if (idMatch) {
      const it = this.store.getItem(Number(idMatch[1]));
      if (it && it.status === 'open') target = it;
      else return { status: 'none' };
    } else {
      const hits = this.rankItems(this.store.openTasks(), r, { requireText: true, k: 5 });
      const terms = new Set(tokenize(r));
      const good = hits.filter((h) => {
        const have = new Set(tokenize(`${h.item.title} ${this.projectSlug(h.item.projectId) ?? ''}`));
        return terms.size > 0 && [...terms].filter((t) => have.has(t)).length / terms.size >= 0.5;
      });
      if (good.length === 0) return { status: 'none' };
      const clear = good.length === 1 || good[0]!.score - good[1]!.score >= 0.15;
      if (!clear) return { status: 'ambiguous', candidates: good.map((g) => g.item) };
      target = good[0]!.item;
    }
    applyActions(this.store, this.commandBatch('done'), 'user', null, [{ type: 'complete_item', itemId: target.id }], this.now());
    this.refresh();
    return { status: 'done', item: this.store.getItem(target.id)! };
  }

  snooze(id: number, until: number): Item {
    const it = this.store.getItem(id);
    if (!it || it.status !== 'open') throw new Error(`No open task #${id}`);
    const action: ResolvedAction = { type: 'update_item', itemId: id, patch: { snoozedUntil: until } };
    applyActions(this.store, this.commandBatch('snooze'), 'user', null, [action], this.now());
    this.refresh();
    return this.store.getItem(id)!;
  }

  undo(): UndoResult {
    const r = undoLast(this.store, this.now());
    this.refresh();
    return r;
  }

  search(query: string, k = 15) {
    return this.rankItems(this.store.allItems(), query, { requireText: true, k });
  }

  projects(): { project: Project; open: number; lastCheckpoint: Checkpoint | null }[] {
    const counts = this.store.projectOpenCounts();
    return this.store.listProjects().map((p) => ({
      project: p, open: counts.get(p.id) ?? 0, lastCheckpoint: this.store.checkpointsFor(p.id, 1)[0] ?? null,
    }));
  }

  // ---------------------------------------------------------------- status

  status(): StatusSummary {
    const now = this.now();
    const open = this.store.openTasks();
    const upcoming = open.filter((t) => t.dueAt !== null && t.dueAt >= now).sort((a, b) => a.dueAt! - b.dueAt!);
    const lastCp = this.store.latestCheckpoint();
    const lastProject = lastCp ? this.store.getProject(lastCp.projectId) : null;
    return {
      next: upcoming[0] ? { id: upcoming[0].id, title: upcoming[0].title, dueAt: upcoming[0].dueAt! } : null,
      overdue: open.filter((t) => t.dueAt !== null && t.dueAt < now).length,
      openTasks: open.length,
      briefReady: Boolean(this.store.getBrief(localDateKey(now))),
      last: lastCp && lastProject
        ? { project: lastProject.slug, text: lastCp.nextStep ? `next: ${lastCp.nextStep}` : lastCp.summary }
        : null,
      now,
    };
  }

  // ---------------------------------------------------------------- tick

  nudgePolicy(): NudgePolicy {
    return {
      ladder: this.config.nudges.ladder.map(parseDurationMs),
      startBuffer: this.config.nudges.startBuffer,
      quietStart: parseHm(this.config.quietHours.start),
      quietEnd: parseHm(this.config.quietHours.end),
      dailyCap: this.config.nudges.dailyCap,
      remindGraceMs: 2 * HOUR,
    };
  }

  /** Run by the background job every few minutes. */
  async tick(notify: Notifier): Promise<TickResult> {
    const result: TickResult = { processed: 0, briefGenerated: false, briefNotified: false, sent: [], skipped: [], held: [] };
    result.processed = await this.processPending();

    const now = this.now();
    const policy = this.nudgePolicy();
    const quiet = inQuietHours(now, policy);
    const minutes = localMinutes(now);
    const inDay = minutes >= parseHm(this.config.briefAt) && minutes < parseHm(this.config.schedule.dayEnd);
    const date = localDateKey(now);

    if (inDay && !quiet) {
      let brief = this.store.getBrief(date);
      if (!brief) {
        await this.today();
        result.briefGenerated = true;
        brief = this.store.getBrief(date);
      }
      if (brief && !brief.notified) {
        const body = brief.top3.length
          ? brief.top3.map((p, i) => `${i + 1}. ${p.title}`).join('  ')
          : brief.headline;
        if (await notify({ title: 'Hippo: today', subtitle: brief.headline, body })) {
          this.store.markBriefNotified(date);
          result.briefNotified = true;
        }
      }
    }

    if (this.config.nudges.enabled) {
      const sentToday = this.store.nudgesSentSince(startOfLocalDay(now)) + (result.briefNotified ? 1 : 0);
      const plan = planNudges(this.store.openTasks(), now, policy, {
        recorded: (id, step, at) => this.store.nudgeRecorded(id, step, at),
        sentToday,
      });
      for (const n of plan.skip) this.store.recordNudge(n.itemId, n.step, n.scheduledFor, 'skipped', now);
      for (const n of plan.send) {
        if (await notify({ title: 'Hippo', body: n.message })) {
          this.store.recordNudge(n.itemId, n.step, n.scheduledFor, 'sent', now);
          result.sent.push(n);
        }
      }
      result.skipped = plan.skip;
      result.held = plan.held;
    }
    this.store.setMeta('last_tick', String(now));
    this.refresh();
    return result;
  }
}
