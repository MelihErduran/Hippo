import type { Config } from '../config.js';
import type { JsonResult, LlmProvider } from '../llm/provider.js';
import {
  DAY, HOUR, fmtHm, fmtNowForPrompt, fmtRelative, localDateKey, localMinutes, parseHm, toLocalIso, weekdayKey,
} from '../time.js';
import type { BriefBlock, BriefContent, BriefPick, Checkpoint, Item } from '../types.js';
import { PlannerOutput } from './schemas.js';

export interface Window { start: number; end: number } // minutes since local midnight

export interface DayShape {
  fixed: BriefBlock[];
  free: Window[];
}

/** Today's fixed blocks from config, and the free windows left from now until day end. */
export function dayShape(config: Config, now: number): DayShape {
  const dayStart = parseHm(config.schedule.dayStart);
  const dayEnd = parseHm(config.schedule.dayEnd);
  const today = weekdayKey(now);
  const fixed = config.schedule.blocks
    .filter((b) => b.days.includes(today))
    .map((b) => ({ start: parseHm(b.start), end: parseHm(b.end), label: b.label }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const from = Math.max(dayStart, Math.ceil(localMinutes(now) / 5) * 5);
  const free: Window[] = [];
  let cursor = from;
  for (const b of fixed) {
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, dayEnd) });
    cursor = Math.max(cursor, b.end);
  }
  if (dayEnd > cursor) free.push({ start: cursor, end: dayEnd });
  return {
    fixed: fixed.map((b) => ({ start: fmtHm(b.start), end: fmtHm(b.end), label: b.label, taskId: null, fixed: true })),
    free: free.filter((w) => w.end - w.start >= 15),
  };
}

export interface PlannerContext {
  now: number;
  config: Config;
  shape: DayShape;
  tasks: { item: Item; project: string | null }[];
  checkpoints: { checkpoint: Checkpoint; project: string }[];
  carryOver: number[]; // yesterday's top 3 still open
}

/** Pick the tasks worth showing the planner: overdue, due soon, then the rest by age. */
export function plannerCandidates(open: Item[], now: number, limit = 25): Item[] {
  const active = open.filter((t) => !t.snoozedUntil || t.snoozedUntil <= now + 12 * HOUR);
  const soon = active.filter((t) => t.dueAt !== null && t.dueAt <= now + 7 * DAY).sort((a, b) => a.dueAt! - b.dueAt!);
  const rest = active.filter((t) => !soon.includes(t)).sort((a, b) => b.updatedAt - a.updatedAt);
  return [...soon, ...rest].slice(0, limit);
}

export const PLANNER_SYSTEM = `You are the planning agent inside Hippo, a second brain for a person with ADHD.
Write their plan for today.

Rules:
- top3: at most three tasks. Overdue and due-soon work first, but stay realistic for the free time available.
- first_step: a concrete physical action that takes under two minutes to start ("open the PDF and read problem 1"), never "work on X".
- blocks: schedule focus blocks only inside the free windows given, as HH:MM. Leave gaps; do not fill every minute. Do not repeat the fixed commitments.
- defer: tasks that will not fit today, with a short honest reason.
- Overdue tasks get re-planned, never scolded. No guilt, no streaks, no exclamation spam.
- headline: one sentence about the shape of the day.`;

export function plannerPrompt(ctx: PlannerContext): string {
  const free = ctx.shape.free.map((w) => `${fmtHm(w.start)}-${fmtHm(w.end)}`).join(', ') || '(none left today)';
  const fixed = ctx.shape.fixed.map((b) => `${b.start}-${b.end} ${b.label}`).join('\n') || '(none)';
  const tasks = ctx.tasks.map(({ item, project }) => {
    const due = item.dueAt ? ` due ${toLocalIso(item.dueAt)} (${fmtRelative(item.dueAt, ctx.now)})` : '';
    const est = item.estimateMin ? ` est ${item.estimateMin}m` : '';
    const carry = ctx.carryOver.includes(item.id) ? ' [was in yesterday\'s top 3]' : '';
    return `- #${item.id} ${item.title}${project ? ` [${project}]` : ''}${due}${est}${carry}`;
  }).join('\n') || '(no open tasks)';
  const cps = ctx.checkpoints.map(({ checkpoint, project }) =>
    `- ${project}: ${checkpoint.summary}${checkpoint.nextStep ? ` (next: ${checkpoint.nextStep})` : ''}`).join('\n') || '(none)';
  return `Now: ${fmtNowForPrompt(ctx.now)}

Fixed commitments today:
${fixed}

Free windows today: ${free}

Open tasks:
${tasks}

Recent project checkpoints:
${cps}`;
}

export async function planWithModel(provider: LlmProvider, ctx: PlannerContext): Promise<JsonResult<PlannerOutput>> {
  return provider.generateJson({
    agent: 'planner',
    system: PLANNER_SYSTEM,
    prompt: plannerPrompt(ctx),
    schema: PlannerOutput,
    schemaName: 'plan_today',
    schemaDescription: 'Today\'s plan: top three tasks with first steps, focus blocks, deferrals.',
    tier: 'smart',
    maxTokens: 4096,
  });
}

function safeHm(s: string): number | null {
  try {
    return parseHm(s);
  } catch {
    return null;
  }
}

/** Turn model output into a BriefContent, dropping anything that does not check out. */
export function normalizePlan(out: PlannerOutput, ctx: PlannerContext, source: 'model' | 'offline'): BriefContent {
  const byId = new Map(ctx.tasks.map((t) => [t.item.id, t.item]));
  const seen = new Set<number>();
  const top3: BriefPick[] = [];
  for (const p of out.top3) {
    const it = byId.get(p.task_id);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    top3.push({ taskId: it.id, title: it.title, why: p.why, firstStep: p.first_step, dueAt: it.dueAt });
  }
  const blocks: BriefBlock[] = [];
  for (const b of out.blocks) {
    const s = safeHm(b.start);
    const e = safeHm(b.end);
    if (s === null || e === null || e <= s) continue;
    const win = ctx.shape.free.find((w) => s < w.end && e > w.start);
    if (!win) continue;
    const cs = Math.max(s, win.start);
    const ce = Math.min(e, win.end);
    if (ce - cs < 10) continue;
    const taskId = b.task_id && byId.has(b.task_id) ? b.task_id : null;
    blocks.push({ start: fmtHm(cs), end: fmtHm(ce), label: b.label, taskId, fixed: false });
  }
  const all = [...ctx.shape.fixed, ...blocks].sort((a, b) => a.start.localeCompare(b.start));
  const defer = out.defer
    .filter((d) => byId.has(d.task_id) && !seen.has(d.task_id))
    .map((d) => ({ taskId: d.task_id, title: byId.get(d.task_id)!.title, reason: d.reason }));
  return {
    date: localDateKey(ctx.now),
    headline: out.headline,
    top3,
    blocks: all,
    defer,
    note: out.note ?? null,
    source,
    generatedAt: ctx.now,
  };
}

// ---- offline planner

function firstStepFor(title: string): string {
  const t = title.toLowerCase();
  const rest = title.replace(/^\S+\s*/, '');
  if (/^(email|text|message|ask|reply|respond|contact|tell)\b/.test(t)) return `Open a message to ${rest || 'them'} and write the first line`;
  if (/^call\b/.test(t)) return 'Pull up the number and hit call';
  if (/^(read|review)\b/.test(t)) return 'Open it and read the first page';
  if (/^(write|draft)\b/.test(t) || /\bessay\b/.test(t)) return 'Open a blank doc and write one rough sentence';
  if (/\b(hw|homework|pset|problem set|assignment|lab)\b/.test(t) || /\b[a-z]{2,6}\d{2,3}\b/.test(t)) return 'Open the assignment and read problem 1';
  if (/\b(apply|application)\b/.test(t)) return 'Open the application page';
  if (/^(buy|order|book|pay)\b/.test(t)) return 'Open the site or app for it';
  return 'Set a 10-minute timer and start on it';
}

function urgencyScore(t: Item, now: number): number {
  if (t.dueAt === null) return 0.1 * Math.pow(0.5, (now - t.updatedAt) / (14 * DAY));
  const hours = (t.dueAt - now) / HOUR;
  return hours <= 0 ? 1.5 : Math.pow(0.5, hours / 48);
}

export function planOffline(ctx: PlannerContext): BriefContent {
  const ranked = [...ctx.tasks].sort((a, b) =>
    urgencyScore(b.item, ctx.now) + (ctx.carryOver.includes(b.item.id) ? 0.2 : 0) -
    (urgencyScore(a.item, ctx.now) + (ctx.carryOver.includes(a.item.id) ? 0.2 : 0)));
  const picks = ranked.slice(0, 3);
  const free = ctx.shape.free.map((w) => ({ ...w }));
  const blocks: PlannerOutput['blocks'] = [];
  for (const { item } of picks) {
    const want = Math.min(item.estimateMin ?? 45, 90);
    const win = free.find((w) => w.end - w.start >= want) ?? free.find((w) => w.end - w.start >= 25);
    if (!win) continue;
    const len = Math.min(want, win.end - win.start);
    blocks.push({ start: fmtHm(win.start), end: fmtHm(win.start + len), task_id: item.id, label: item.title });
    win.start += len + 10; // leave a breather
  }
  const overdue = ctx.tasks.filter((t) => t.item.dueAt !== null && t.item.dueAt < ctx.now && !picks.includes(t));
  const n = picks.length;
  const out: PlannerOutput = {
    headline: n === 0
      ? 'Nothing urgent on the list today.'
      : `${n} thing${n > 1 ? 's' : ''} matter today. Start with the first one.`,
    top3: picks.map(({ item }) => ({
      task_id: item.id,
      why: item.dueAt === null ? 'been waiting a while' : item.dueAt < ctx.now ? 'overdue, worth clearing' : `due ${fmtRelative(item.dueAt, ctx.now)}`,
      first_step: firstStepFor(item.title),
    })),
    blocks,
    defer: overdue.slice(0, 5).map(({ item }) => ({ task_id: item.id, reason: 'overdue, pick a new date with hippo snooze' })),
    note: null,
  };
  return normalizePlan(out, ctx, 'offline');
}
