import type { JsonResult, LlmProvider } from '../llm/provider.js';
import { calendarForPrompt, fmtNowForPrompt, toLocalIso } from '../time.js';
import type { Item, Project } from '../types.js';
import { FilerOutput } from './schemas.js';

export interface FilerContext {
  now: number;
  dump: string;
  projects: Project[];
  /** Open tasks most relevant to this dump (picked by the ranker), with project slugs. */
  openTasks: { item: Item; project: string | null }[];
  /** Open notes/ideas relevant to this dump (or referenced by #id). */
  openNotes: { item: Item; project: string | null }[];
}

export const FILER_SYSTEM = `You are the filing agent inside Hippo, a second brain for a person with ADHD.
You receive one raw brain dump and turn it into actions. The person should never have to organize anything.

How to file:
- Split the dump into separate items. One sentence can hold several items.
- create_task: something they must do. Imperative title in their own words, 3-8 words, fix obvious typos.
- create_note kind=idea: a possibility to explore later ("idea:", "what if", "maybe build").
- create_note kind=note: information worth keeping that is not a task. Do NOT create a note that only says two listed items are the same — update/drop instead.
- complete_task: when they describe having done an open task's action (emailed, replied, messaged, checked, submitted, finished, …) and it matches a listed open task id — even if they also say they are now waiting on a reply. Prefer completing that id over only parking.
- update_task: prefer this for progress on a listed open task. Set title to the concrete next action (e.g. "Wait for Navid's reply"). Also use for due/estimate/project changes. Set clear_due=true when they say remove/clear the due date, it is not scheduled yet, or the deadline no longer applies. Never invent a new due date they did not give.
- drop_item: remove a listed open task or note that is a duplicate or obsolete (e.g. "task #4 is the same as note #33" → update the surviving task, drop_item the duplicate note).
- checkpoint: progress on a project when no single listed open task clearly fits. Put what they did in summary and the next step in next_step. At most one checkpoint per distinct thread of work in the dump.
- Never merge two distinct open tasks into one title. Keep separate threads on separate task ids (e.g. soldering vs lab makeup stay different).
- One dump may mix completes, updates, drops, and checkpoints. Match listed ids whenever the dump clearly maps to them.
- When unsure, make it a note. Never drop anything they said without an id match.

Projects:
- Reuse an existing project slug when the item clearly belongs to it.
- Otherwise use a short lowercase slug for a clear project or course (course codes like cs161 are projects).
- Leave project null when it is not clear. Do not invent projects for one-off errands.

Dates:
- Output local times as "YYYY-MM-DDTHH:MM". If only a day is given, output "YYYY-MM-DD" (means end of day).
- Use the calendar provided. Never compute dates from memory.
- Never invent a deadline. remind_at only when they ask to be reminded at a time.
- To remove a due date, set clear_due=true on update_task (do not omit the field and claim it was cleared).

reply: optional, one short warm line. No guilt, no exclamation spam.`;

export function filerPrompt(ctx: FilerContext): string {
  const projects = ctx.projects.length
    ? ctx.projects.slice(0, 40).map((p) => `- ${p.slug}${p.name !== p.slug ? ` (${p.name})` : ''}`).join('\n')
    : '(none yet)';
  const tasks = ctx.openTasks.length
    ? ctx.openTasks.map(({ item, project }) =>
        `- #${item.id} ${item.title}${project ? ` [${project}]` : ''}${item.dueAt ? ` due ${toLocalIso(item.dueAt)}` : ''}`).join('\n')
    : '(none)';
  const notes = ctx.openNotes.length
    ? ctx.openNotes.map(({ item, project }) =>
        `- #${item.id} (${item.kind}) ${item.title}${project ? ` [${project}]` : ''}`).join('\n')
    : '(none)';
  return `Now: ${fmtNowForPrompt(ctx.now)}

Calendar:
${calendarForPrompt(ctx.now)}

Existing projects:
${projects}

Relevant open tasks:
${tasks}

Relevant open notes:
${notes}

Brain dump:
"""
${ctx.dump}
"""`;
}

export async function fileWithModel(provider: LlmProvider, ctx: FilerContext): Promise<JsonResult<FilerOutput>> {
  return provider.generateJson({
    agent: 'filer',
    system: FILER_SYSTEM,
    prompt: filerPrompt(ctx),
    schema: FilerOutput,
    schemaName: 'file_brain_dump',
    schemaDescription: 'Turn a brain dump into filing actions.',
    tier: 'fast',
    maxTokens: 2048,
  });
}
