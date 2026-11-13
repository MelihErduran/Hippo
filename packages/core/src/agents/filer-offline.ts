import * as chrono from 'chrono-node';
import { DEFAULT_WEIGHTS, type Ranker } from '../rank/ranker.js';
import { tokenize } from '../rank/tokenize.js';
import { toLocalIso } from '../time.js';
import type { Item, Project } from '../types.js';
import { capitalize, slugify } from '../util.js';
import type { FilerAction, FilerOutput } from './schemas.js';

// Rule-based filer. Runs with no API key, when a model call fails, and in
// tests. It emits the same FilerAction shape as the model, so it goes through
// the same validation and undo path.

export interface OfflineFilerContext {
  now: number;
  projects: Project[];
  openTasks: { item: Item; project: string | null }[];
  openNotes?: { item: Item; project: string | null }[];
  ranker: Ranker;
}

const DEPTS = new Set(['cs', 'compsci', 'ics', 'math', 'stats', 'stat', 'phys', 'physics', 'chem', 'bio', 'econ',
  'eng', 'engr', 'writing', 'swe', 'cse', 'ece', 'eecs', 'psych', 'hist', 'phil', 'inf', 'in4matx']);
const COURSE_RE = /\b([a-z]{2,8})\s?(\d{2,3}[a-z]?)\b/gi;

const DONE_RE = /^(?:done|finished|completed|submitted|sent)\b(?:\s+with)?\s*[:\-]?\s*(.+)$/i;
const DONE_SUFFIX_RE = /^(.+?)\s+(?:is\s+|are\s+)?(?:done|finished|submitted)\.?$/i;
const IDEA_RE = /^(?:idea|what if|maybe (?:build|make|try)|thought)\b\s*[:\-]?\s*/i;
const CHECKPOINT_CUES = /\b(left off|halfway|half way|stopped at|next is|next:|next step|in the middle of|got through|progress on)/i;
const PREFIX_RE = /^#?([\p{L}\p{N}][\p{L}\p{N}_-]{0,30}):\s+(.+)$/u;
const TASK_START = /^(?:to-?do|todo|i need to|need to|i have to|have to|gotta|must|i should|should|remember to|don'?t forget to|remind me to|remind me)\b\s*:?\s*/i;
const NEXT_SPLIT = /,?\s*(?:next is|next step is|next step:|next:|then next)\s*/i;
const TASK_VERBS = new Set(['ask', 'email', 'text', 'call', 'message', 'buy', 'get', 'finish', 'submit', 'apply', 'schedule',
  'book', 'pay', 'fix', 'write', 'study', 'review', 'read', 'send', 'prepare', 'prep', 'clean', 'return', 'pick', 'order',
  'register', 'sign', 'update', 'reply', 'respond', 'follow', 'check', 'plan', 'practice', 'research', 'renew', 'cancel',
  'print', 'install', 'set', 'make', 'meet', 'go', 'do', 'start', 'complete', 'upload', 'fill', 'grab', 'bring', 'drop',
  'talk', 'tell', 'watch', 'learn', 'build', 'refactor', 'deploy', 'test', 'push', 'merge', 'draft', 'contact', 'find']);
const RESERVED_PREFIXES = new Set(['idea', 'todo', 'to-do', 'note', 'task', 'remind', 'reminder']);

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** Split a dump into item-sized segments. */
export function segment(dump: string): string[] {
  const parts = dump
    .split(/\n+|;|(?<=[.!?])\s+(?=[\p{L}#\d])/u)
    .map((s) => s.trim().replace(/[.]+$/, ''))
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const commas = p.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    const splittable =
      commas.length >= 2 &&
      !CHECKPOINT_CUES.test(p) &&
      !commas.some((c) => /^(?:next|then|and then)\b/i.test(c)) &&
      commas.every((c) => words(c).length >= 2) &&
      commas.filter((c) => words(c).length >= 3).length >= 2;
    if (splittable) out.push(...commas);
    else out.push(p);
  }
  return out;
}

function courseCode(text: string): string | null {
  for (const m of text.matchAll(COURSE_RE)) {
    if (DEPTS.has(m[1]!.toLowerCase())) return `${m[1]}${m[2]}`.toLowerCase();
  }
  return null;
}

function detectProject(text: string, projects: Project[]): string | null {
  const tag = /(?:^|\s)#([\p{L}\p{N}_-]+)/u.exec(text);
  if (tag) return slugify(tag[1]!);
  const lower = text.toLowerCase();
  for (const p of projects) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${p.slug.replace(/[-]/g, '[- ]?')}([^\\p{L}\\p{N}]|$)`, 'u');
    if (re.test(lower)) return p.slug;
  }
  return courseCode(text);
}

function cleanTitle(raw: string, dateText: string | null): string {
  let t = raw;
  if (dateText) t = t.replace(dateText, ' ');
  t = t
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TASK_START, '')
    .replace(/^to\s+/i, '')
    .replace(/(?:^|\s)#[\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\b(?:due|by|on|at|before)\s*$/i, '')
    .replace(/\s+(?:due|by)\s+(?=[,.]|$)/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:;-]+|[\s,:;.-]+$/g, '');
  t = t.replace(COURSE_RE, (m, d: string, num: string) => (DEPTS.has(d.toLowerCase()) ? `${d.toUpperCase()}${num.toUpperCase()}` : m));
  return capitalize(t).slice(0, 120) || capitalize(raw.trim()).slice(0, 120);
}

function parseDate(text: string, now: number): { ms: number; text: string; hasTime: boolean } | null {
  const results = chrono.parse(text, new Date(now), { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  const hasTime = r.start.isCertain('hour');
  const d = r.start.date();
  if (!hasTime) d.setHours(23, 59, 0, 0);
  return { ms: d.getTime(), text: r.text, hasTime };
}

function looksLikeTask(text: string, hasDate: boolean): boolean {
  if (TASK_START.test(text)) return true;
  const first = words(text)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (TASK_VERBS.has(first)) return true;
  if (/\b(?:hw\d*|homework|assignment|pset|problem set|essay|quiz|midterm|exam|application|deadline)\b/i.test(text)) return true;
  return hasDate && /\bdue\b|\bby\b/i.test(text);
}

function findOpenTask(phrase: string, ctx: OfflineFilerContext): Item | null {
  const terms = new Set(tokenize(phrase));
  if (terms.size === 0) return null;
  const docs = ctx.openTasks.map(({ item, project }) => ({
    id: item.id, text: `${item.title} ${project ?? ''}`, updatedAt: item.updatedAt, dueAt: item.dueAt, project,
  }));
  const hits = ctx.ranker.rank(docs, { text: phrase, now: ctx.now, requireText: true, k: 3 }, DEFAULT_WEIGHTS);
  for (const h of hits) {
    const doc = docs.find((d) => d.id === h.id)!;
    const docTerms = new Set(tokenize(doc.text));
    const covered = [...terms].filter((t) => docTerms.has(t)).length;
    if (covered / terms.size >= 0.5) return ctx.openTasks.find((t) => t.item.id === h.id)!.item;
  }
  return null;
}

export function fileOffline(dump: string, ctx: OfflineFilerContext): FilerOutput {
  const actions: FilerAction[] = [];
  const projectSlugs = new Set(ctx.projects.map((p) => p.slug));

  for (const seg of segment(dump)) {
    // 1. "done X" / "X is done"
    const done = DONE_RE.exec(seg) ?? DONE_SUFFIX_RE.exec(seg);
    if (done) {
      const task = findOpenTask(done[1]!, ctx);
      if (task) {
        actions.push({ type: 'complete_task', task_id: task.id });
        continue;
      }
    }

    // 2. "project: ..." prefix
    let text = seg;
    let project: string | null = null;
    const prefix = PREFIX_RE.exec(seg);
    if (prefix && !RESERVED_PREFIXES.has(prefix[1]!.toLowerCase())) {
      project = slugify(prefix[1]!);
      text = prefix[2]!;
    }

    // 3. checkpoint: progress language, attached to a project
    if (CHECKPOINT_CUES.test(text)) {
      const proj = project ?? detectProject(text, ctx.projects);
      if (proj) {
        const [summary, ...rest] = text.split(NEXT_SPLIT);
        const next = rest.join(' ').trim() || null;
        actions.push({
          type: 'checkpoint',
          project: proj,
          summary: capitalize((summary ?? text).trim()) || capitalize(text),
          next_step: next ? capitalize(next) : null,
        });
        continue;
      }
    }

    // 4. ideas
    if (IDEA_RE.test(text)) {
      const body = text.replace(IDEA_RE, '').trim();
      actions.push({
        type: 'create_note', kind: 'idea', title: capitalize(body).slice(0, 120) || capitalize(text),
        body: null, project: project ?? detectProject(body, ctx.projects),
      });
      continue;
    }

    // 5. tasks and reminders
    const date = parseDate(text, ctx.now);
    const isReminder = /\bremind me\b/i.test(text);
    const proj = project ?? detectProject(text, ctx.projects);
    if (isReminder || looksLikeTask(text, Boolean(date)) || (project && projectSlugs.has(project))) {
      actions.push({
        type: 'create_task',
        title: cleanTitle(text, date?.text ?? null),
        project: proj,
        due: !isReminder && date ? toLocalIso(date.ms) : null,
        remind_at: isReminder && date ? toLocalIso(date.ms) : null,
        estimate_min: null,
        notes: null,
      });
      continue;
    }

    // 6. everything else is kept as a note
    actions.push({ type: 'create_note', kind: 'note', title: capitalize(text).slice(0, 120), body: text.length > 120 ? text : null, project: proj });
  }
  return { actions, reply: null };
}
