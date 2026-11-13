import type { JsonResult, LlmProvider } from '../llm/provider.js';
import { fmtNowForPrompt, fmtRelative, fmtWhen } from '../time.js';
import type { Capture, Checkpoint, Item, Project, RecallResult } from '../types.js';
import { RecallOutput } from './schemas.js';

export interface RecallContext {
  now: number;
  project: Project;
  checkpoints: Checkpoint[]; // newest first
  openTasks: Item[];
  recentItems: Item[]; // notes, ideas, done tasks
  recentDumps: Capture[];
}

export const RECALL_SYSTEM = `You are the recall agent inside Hippo, a second brain for a person with ADHD.
They got distracted and need to get back into a project fast. Using only the data given:
- last_state: 1-2 sentences, second person, what they were doing and roughly when.
- next_step: one concrete next action. Prefer the newest checkpoint's next step if it is still open.
- open_loops: open tasks or unanswered questions that matter for this project, with item ids when they come from the task list.
Be brief and specific. Never invent progress that is not in the data.`;

export function recallPrompt(ctx: RecallContext): string {
  const cps = ctx.checkpoints.map((c) =>
    `- ${fmtWhen(c.createdAt, ctx.now)}: ${c.summary}${c.nextStep ? ` (next: ${c.nextStep})` : ''}`).join('\n') || '(none)';
  const tasks = ctx.openTasks.map((t) =>
    `- #${t.id} ${t.title}${t.dueAt ? ` due ${fmtRelative(t.dueAt, ctx.now)}` : ''}`).join('\n') || '(none)';
  const items = ctx.recentItems.map((i) =>
    `- [${i.status === 'done' ? 'done' : i.kind}] ${i.title}${i.body ? `: ${i.body}` : ''}`).join('\n') || '(none)';
  const dumps = ctx.recentDumps.map((d) => `- ${fmtWhen(d.createdAt, ctx.now)}: ${d.text}`).join('\n') || '(none)';
  return `Now: ${fmtNowForPrompt(ctx.now)}
Project: ${ctx.project.slug} (last touched ${fmtWhen(ctx.project.lastTouchedAt, ctx.now)})

Checkpoints, newest first:
${cps}

Open tasks:
${tasks}

Recent notes, ideas and finished tasks:
${items}

Recent brain dumps that mention it:
${dumps}`;
}

export async function recallWithModel(provider: LlmProvider, ctx: RecallContext): Promise<JsonResult<RecallOutput>> {
  return provider.generateJson({
    agent: 'recall',
    system: RECALL_SYSTEM,
    prompt: recallPrompt(ctx),
    schema: RecallOutput,
    schemaName: 'recall_context',
    schemaDescription: 'Where the person left off on a project and what to do next.',
    tier: 'smart',
    maxTokens: 2048,
  });
}

export function normalizeRecall(out: RecallOutput, ctx: RecallContext, source: 'model' | 'offline'): RecallResult {
  const openIds = new Set(ctx.openTasks.map((t) => t.id));
  return {
    project: ctx.project,
    lastTouchedAt: ctx.project.lastTouchedAt,
    lastState: out.last_state,
    nextStep: out.next_step,
    openLoops: out.open_loops.map((l) => ({ itemId: l.item_id && openIds.has(l.item_id) ? l.item_id : null, text: l.text })),
    note: out.note ?? null,
    source,
  };
}

export function recallOffline(ctx: RecallContext): RecallResult {
  const cp = ctx.checkpoints[0];
  const lastState = cp
    ? `${cp.summary} (${fmtWhen(cp.createdAt, ctx.now)})`
    : ctx.recentItems[0]
      ? `Last thing filed here: ${ctx.recentItems[0].title}`
      : 'No checkpoints yet. Use hippo park to save where you are next time.';
  const nextStep = cp?.nextStep ?? ctx.openTasks[0]?.title ?? 'Pick the smallest open task and do 10 minutes of it';
  return normalizeRecall({
    last_state: lastState,
    next_step: nextStep,
    open_loops: ctx.openTasks.slice(0, 6).map((t) => ({ item_id: t.id, text: t.title })),
    note: null,
  }, ctx, 'offline');
}
