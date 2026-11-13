import { tokenize } from '../rank/tokenize.js';
import type { ItemPatch, Store } from '../store/store.js';
import { DAY, parseLocalDateTime } from '../time.js';
import type { Applied, Item, ItemKind, Project } from '../types.js';
import { levenshtein, slugify, truncate } from '../util.js';
import type { FilerAction } from './schemas.js';

// The action-plan pattern: agents propose, this module validates and applies.
// Nothing an agent returns touches the database without passing through here,
// and every applied change is logged with its before-state so `undo` works.

export type ProjectRef = { id: number } | { newSlug: string; name: string };

/** Open tasks on a project, newest first (itemsByProject is updated_at DESC). */
function openTasksForProject(store: Store, projectId: number): Item[] {
  return store.itemsByProject(projectId).filter((i) => i.kind === 'task' && i.status === 'open');
}

/**
 * Pick the open task whose title best overlaps the checkpoint text.
 * Falls back to most recently updated. Skips ids already claimed in this batch.
 */
function matchOpenTaskForCheckpoint(
  store: Store,
  projectId: number,
  summary: string,
  nextStep: string,
  usedIds: Set<number>,
): Item | null {
  const candidates = openTasksForProject(store, projectId).filter((t) => !usedIds.has(t.id));
  if (candidates.length === 0) return null;
  const needle = tokenize(`${summary} ${nextStep}`);
  if (needle.length === 0) return candidates[0]!;
  const terms = new Set(needle);
  let best: { item: Item; score: number } | null = null;
  for (const item of candidates) {
    const titleTerms = new Set(tokenize(item.title));
    if (titleTerms.size === 0) continue;
    const covered = [...terms].filter((t) => titleTerms.has(t)).length;
    const score = covered / terms.size;
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  // Prefer a clear overlap; otherwise newest unused open task.
  if (best && best.score >= 0.2) return best.item;
  return candidates[0]!;
}

/** Seed old title on first rewrite; append checkpoint summary as a progress line. */
function appendCheckpointHistory(
  body: string | null,
  previousTitle: string,
  summary: string,
  titleChanged: boolean,
): string {
  const existing = body?.trim() ?? '';
  const lines: string[] = [];
  if (existing) lines.push(existing);
  else if (titleChanged) lines.push(previousTitle);
  const bullet = `- ${summary}`;
  const last = lines.length ? lines[lines.length - 1]!.split('\n').pop()! : '';
  if (last === bullet) return lines.join('\n');
  lines.push(bullet);
  return lines.join('\n');
}

export type ResolvedAction =
  | {
      type: 'create_item';
      kind: ItemKind;
      title: string;
      body: string | null;
      project: ProjectRef | null;
      dueAt: number | null;
      remindAt: number | null;
      estimateMin: number | null;
    }
  | { type: 'complete_item'; itemId: number }
  | { type: 'update_item'; itemId: number; patch: ItemPatch; project?: ProjectRef | null }
  | { type: 'drop_item'; itemId: number }
  | { type: 'create_checkpoint'; project: ProjectRef; summary: string; nextStep: string | null };

const digits = (s: string) => (s.match(/\d+/g) ?? []).join(',');

/** Find an existing project a name refers to, tolerating small typos. */
export function matchProject(projects: Project[], raw: string): Project | null {
  const slug = slugify(raw);
  if (!slug) return null;
  const flat = slug.replace(/-/g, '');
  let best: { p: Project; d: number } | null = null;
  for (const p of projects) {
    if (p.slug === slug || p.name.toLowerCase() === raw.trim().toLowerCase()) return p;
    if (p.slug.replace(/-/g, '') === flat) return p;
    // cs161 and cs162 are different courses: digits must agree exactly.
    if (digits(p.slug) !== digits(slug)) continue;
    const d = levenshtein(p.slug, slug);
    const limit = Math.min(p.slug.length, slug.length) <= 5 ? 1 : 2;
    if (d <= limit && (!best || d < best.d)) best = { p, d };
    const prefix = (p.slug.startsWith(slug) || slug.startsWith(p.slug)) &&
      Math.min(p.slug.length, slug.length) >= 4 && Math.abs(p.slug.length - slug.length) <= 3;
    if (prefix && (!best || 2 < best.d)) best = { p, d: 2 };
  }
  return best?.p ?? null;
}

export function projectRef(projects: Project[], raw: string | null | undefined): ProjectRef | null {
  if (!raw || !raw.trim()) return null;
  const hit = matchProject(projects, raw);
  if (hit) return { id: hit.id };
  const slug = slugify(raw);
  return slug ? { newSlug: slug, name: raw.trim().replace(/^#/, '') } : null;
}

export interface Resolution {
  actions: ResolvedAction[];
  warnings: string[];
}

function checkDate(raw: string | null | undefined, label: string, now: number, warnings: string[]): number | null {
  if (!raw) return null;
  const ms = parseLocalDateTime(raw);
  if (ms === null) {
    warnings.push(`ignored unreadable ${label} "${raw}"`);
    return null;
  }
  if (ms < now - 7 * DAY || ms > now + 730 * DAY) {
    warnings.push(`ignored implausible ${label} "${raw}"`);
    return null;
  }
  return ms;
}

/** Validate model actions against the database. Bad pieces are dropped with a warning, never fatal. */
export function resolveFilerActions(store: Store, actions: FilerAction[], now: number): Resolution {
  const projects = store.listProjects();
  const warnings: string[] = [];
  const out: ResolvedAction[] = [];
  const openTask = (id: number) => {
    const it = store.getItem(id);
    return it && it.kind === 'task' && it.status === 'open' ? it : null;
  };
  const openItem = (id: number) => {
    const it = store.getItem(id);
    return it && it.status === 'open' ? it : null;
  };

  for (const a of actions) {
    switch (a.type) {
      case 'create_task':
        out.push({
          type: 'create_item',
          kind: 'task',
          title: truncate(a.title.trim(), 200),
          body: a.notes?.trim() || null,
          project: projectRef(projects, a.project),
          dueAt: checkDate(a.due, 'due date', now, warnings),
          remindAt: checkDate(a.remind_at, 'reminder', now, warnings),
          estimateMin: a.estimate_min ?? null,
        });
        break;
      case 'create_note':
        out.push({
          type: 'create_item',
          kind: a.kind,
          title: truncate(a.title.trim(), 200),
          body: a.body?.trim() || null,
          project: projectRef(projects, a.project),
          dueAt: null,
          remindAt: null,
          estimateMin: null,
        });
        break;
      case 'complete_task':
        if (openTask(a.task_id)) out.push({ type: 'complete_item', itemId: a.task_id });
        else warnings.push(`skipped completing #${a.task_id}: no open task with that id`);
        break;
      case 'update_task': {
        if (!openTask(a.task_id)) {
          warnings.push(`skipped updating #${a.task_id}: no open task with that id`);
          break;
        }
        const patch: ItemPatch = {};
        if (a.title) patch.title = truncate(a.title.trim(), 200);
        if (a.clear_due) patch.dueAt = null;
        else if (a.due) {
          const due = checkDate(a.due, 'due date', now, warnings);
          if (due !== null) patch.dueAt = due;
        }
        if (a.estimate_min) patch.estimateMin = a.estimate_min;
        const project = a.project ? projectRef(projects, a.project) : undefined;
        if (Object.keys(patch).length || project) out.push({ type: 'update_item', itemId: a.task_id, patch, project });
        break;
      }
      case 'drop_item': {
        if (openItem(a.item_id)) out.push({ type: 'drop_item', itemId: a.item_id });
        else warnings.push(`skipped dropping #${a.item_id}: no open item with that id`);
        break;
      }
      case 'checkpoint': {
        const project = projectRef(projects, a.project);
        if (!project) {
          warnings.push('skipped a checkpoint with no project');
          break;
        }
        out.push({ type: 'create_checkpoint', project, summary: a.summary.trim(), nextStep: a.next_step?.trim() || null });
        break;
      }
    }
  }
  return { actions: out, warnings };
}

/** Apply resolved actions in one transaction and log each one under `batch`. */
export function applyActions(
  store: Store,
  batch: string,
  agent: string,
  captureId: number | null,
  actions: ResolvedAction[],
  now: number,
): Applied[] {
  return store.tx(() => {
    const created = new Map<string, Project>();
    const applied: Applied[] = [];
    const checkpointTaskIds = new Set<number>();
    /** Tasks the filer already updated this batch — do not smash their titles via checkpoint rewrite. */
    const explicitlyUpdatedIds = new Set<number>();

    const projectId = (ref: ProjectRef | null | undefined): number | null => {
      if (!ref) return null;
      if ('id' in ref) {
        store.touchProject(ref.id, now);
        return ref.id;
      }
      const existing = created.get(ref.newSlug) ?? store.projectBySlug(ref.newSlug);
      if (existing) {
        store.touchProject(existing.id, now);
        return existing.id;
      }
      const p = store.insertProject(ref.newSlug, ref.name, now);
      created.set(p.slug, p);
      store.logAction(batch, agent, 'create_project', p.id, { slug: p.slug }, null, now);
      applied.push({ kind: 'project', title: p.slug });
      return p.id;
    };
    const slugOf = (id: number | null) => (id === null ? null : store.getProject(id)?.slug ?? null);

    for (const a of actions) {
      switch (a.type) {
        case 'create_item': {
          const pid = projectId(a.project);
          const item = store.insertItem({
            kind: a.kind, title: a.title, body: a.body, projectId: pid, dueAt: a.dueAt, remindAt: a.remindAt,
            estimateMin: a.estimateMin, captureId, createdAt: now,
          }, now);
          store.logAction(batch, agent, 'create_item', item.id, { kind: a.kind, title: a.title }, null, now);
          applied.push({ kind: a.kind, itemId: item.id, title: item.title, project: slugOf(pid), dueAt: item.dueAt, remindAt: item.remindAt });
          break;
        }
        case 'complete_item': {
          const before = store.getItem(a.itemId);
          if (!before) break;
          store.updateItem(a.itemId, { status: 'done', completedAt: now }, now);
          store.logAction(batch, agent, 'complete_item', a.itemId, {}, { status: before.status, completedAt: before.completedAt }, now);
          if (before.projectId) store.touchProject(before.projectId, now);
          applied.push({ kind: 'done', itemId: a.itemId, title: before.title, project: slugOf(before.projectId) });
          break;
        }
        case 'update_item': {
          const before = store.getItem(a.itemId);
          if (!before) break;
          const patch: ItemPatch = { ...a.patch };
          if (a.project !== undefined) patch.projectId = projectId(a.project);
          const prev: Record<string, unknown> = {};
          for (const k of Object.keys(patch)) prev[k] = before[k as keyof typeof before];
          store.updateItem(a.itemId, patch, now);
          store.logAction(batch, agent, 'update_item', a.itemId, patch, prev, now);
          explicitlyUpdatedIds.add(a.itemId);
          const after = store.getItem(a.itemId)!;
          applied.push({ kind: 'update', itemId: a.itemId, title: after.title, project: slugOf(after.projectId), dueAt: after.dueAt });
          break;
        }
        case 'drop_item': {
          const before = store.getItem(a.itemId);
          if (!before || before.status !== 'open') break;
          store.updateItem(a.itemId, { status: 'dropped' }, now);
          store.logAction(batch, agent, 'update_item', a.itemId, { status: 'dropped' }, { status: before.status }, now);
          if (before.projectId) store.touchProject(before.projectId, now);
          applied.push({ kind: 'drop', itemId: a.itemId, title: before.title, project: slugOf(before.projectId) });
          break;
        }
        case 'create_checkpoint': {
          const pid = projectId(a.project)!;
          const cp = store.insertCheckpoint(pid, a.summary, a.nextStep, captureId, now);
          store.logAction(batch, agent, 'create_checkpoint', cp.id, { summary: a.summary }, null, now);
          applied.push({ kind: 'checkpoint', title: a.nextStep ? `next: ${a.nextStep}` : a.summary, project: slugOf(pid) });

          // Approach A: face the best-matching open task with nextStep; keep history in body.
          if (a.nextStep) {
            const skip = new Set([...checkpointTaskIds, ...explicitlyUpdatedIds]);
            const primary = matchOpenTaskForCheckpoint(store, pid, a.summary, a.nextStep, skip);
            if (primary) {
              const newTitle = truncate(a.nextStep, 200);
              const titleChanged = primary.title.toLowerCase() !== newTitle.toLowerCase();
              const newBody = appendCheckpointHistory(primary.body, primary.title, a.summary, titleChanged);
              const patch: ItemPatch = {};
              if (titleChanged) patch.title = newTitle;
              if (newBody !== (primary.body ?? '')) patch.body = newBody;
              if (Object.keys(patch).length) {
                const prev: Record<string, unknown> = {};
                for (const k of Object.keys(patch)) prev[k] = primary[k as keyof typeof primary];
                store.updateItem(primary.id, patch, now);
                store.logAction(batch, agent, 'update_item', primary.id, patch, prev, now);
                checkpointTaskIds.add(primary.id);
                const after = store.getItem(primary.id)!;
                applied.push({
                  kind: 'update',
                  itemId: primary.id,
                  title: after.title,
                  project: slugOf(after.projectId),
                  dueAt: after.dueAt,
                });
              }
            }
          }
          break;
        }
      }
    }
    return applied;
  });
}

export interface UndoResult {
  batch: string | null;
  reverted: string[];
}

/** Reverse the most recent batch that still has active actions. */
export function undoLast(store: Store, now: number): UndoResult {
  const batch = store.lastActiveBatch();
  if (!batch) return { batch: null, reverted: [] };
  return store.tx(() => {
    const reverted: string[] = [];
    const actions = store.actionsForBatch(batch).reverse();
    for (const a of actions) {
      switch (a.type) {
        case 'create_item': {
          const it = store.getItem(a.targetId);
          if (it) {
            store.deleteItem(a.targetId);
            reverted.push(`removed ${it.kind} #${it.id} ${it.title}`);
          }
          break;
        }
        case 'complete_item':
        case 'update_item': {
          const it = store.getItem(a.targetId);
          if (it && a.before && typeof a.before === 'object') {
            store.updateItem(a.targetId, a.before as ItemPatch, now);
            reverted.push(`${a.type === 'complete_item' ? 'reopened' : 'restored'} #${it.id} ${it.title}`);
          }
          break;
        }
        case 'delete_item':
          break; // reserved
        case 'create_checkpoint':
          store.deleteCheckpoint(a.targetId);
          reverted.push('removed a checkpoint');
          break;
        case 'create_project':
          if (!store.projectInUse(a.targetId)) {
            const p = store.getProject(a.targetId);
            store.deleteProject(a.targetId);
            if (p) reverted.push(`removed project ${p.slug}`);
          }
          break;
      }
      store.markUndone(a.id, now);
    }
    return { batch, reverted };
  });
}
