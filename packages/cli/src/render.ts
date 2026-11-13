import type {
  BriefContent, CaptureResult, Item, RecallResult, StatusSummary, TaskGroups,
} from '@hippo/core';
import { fmtRelative, fmtWhen } from '@hippo/core';
import pc from 'picocolors';

type Colors = ReturnType<typeof pc.createColors>;
const c: Colors = pc;

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)}…` : s + ' '.repeat(n - s.length));

export function dueLabel(dueAt: number | null, now: number, colors: Colors = c): string {
  if (dueAt === null) return '';
  const rel = fmtRelative(dueAt, now);
  const text = `due ${fmtWhen(dueAt, now)}`;
  if (dueAt < now) return colors.red(`${rel}`);
  if (dueAt - now < 24 * 3_600_000) return colors.yellow(text);
  return colors.dim(text);
}

export function renderCapture(r: CaptureResult, now: number): string {
  const real = r.applied.filter((a) => a.kind !== 'project');
  const lines: string[] = [];
  lines.push(`  ${c.bold(`Filed ${real.length} thing${real.length === 1 ? '' : 's'}`)}${r.source === 'offline' ? c.dim('  (offline filer)') : ''}`);
  for (const a of real) {
    const id = a.itemId ? `#${a.itemId}` : '';
    const proj = a.project ? c.cyan(a.project) : '';
    switch (a.kind) {
      case 'task':
      case 'note':
      case 'idea': {
        const when = a.remindAt ? c.yellow(`remind ${fmtWhen(a.remindAt, now)}`) : dueLabel(a.dueAt ?? null, now);
        lines.push(`  ${c.green('+')} ${pad(a.kind, 5)} ${pad(id, 5)} ${pad(a.title, 46)} ${stripAnsiPad(when, 24)} ${proj}`.trimEnd());
        break;
      }
      case 'checkpoint':
        lines.push(`  ${c.green('+')} park  ${pad('', 5)} ${a.project ? `${c.cyan(a.project)}: ` : ''}${a.title}`);
        break;
      case 'done':
        lines.push(`  ${c.green('✓')} done  ${pad(id, 5)} ${a.title}`);
        break;
      case 'drop':
        lines.push(`  ${c.dim('×')} drop  ${pad(id, 5)} ${a.title}`);
        break;
      case 'update':
        lines.push(`  ${c.blue('~')} edit  ${pad(id, 5)} ${a.title} ${dueLabel(a.dueAt ?? null, now)}`);
        break;
    }
  }
  const newProjects = r.applied.filter((a) => a.kind === 'project').map((a) => a.title);
  if (newProjects.length) lines.push(c.dim(`  new project${newProjects.length > 1 ? 's' : ''}: ${newProjects.join(', ')}`));
  for (const w of r.warnings) lines.push(c.yellow(`  ! ${w}`));
  if (r.reply) lines.push(`  ${c.italic(r.reply)}`);
  const nudged = real.filter((a) => a.kind === 'task' && (a.dueAt || a.remindAt)).map((a) => `#${a.itemId}`);
  const tail = nudged.length ? `Nudges set for ${nudged.join(', ')}. ` : '';
  lines.push(c.dim(`  ${tail}Wrong? hippo undo`));
  if (r.source === 'offline' && r.fallbackReason) lines.push(c.dim(`  offline because: ${r.fallbackReason}`));
  return lines.join('\n');
}

/** Pad a colored string to a visible width. */
function stripAnsiPad(s: string, n: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return visible >= n ? s : s + ' '.repeat(n - visible);
}

export function renderBrief(b: BriefContent, now: number): string {
  const d = new Date(now);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const lines = [`  ${c.bold(day)} ${c.dim('·')} ${b.headline}`, ''];
  if (b.top3.length === 0) lines.push(c.dim('  Nothing on the list. Dump what is in your head: hippo d "..."'));
  b.top3.forEach((p, i) => {
    lines.push(`  ${c.bold(`${i + 1}.`)} ${c.bold(p.title)} ${c.dim(`#${p.taskId}`)}  ${dueLabel(p.dueAt, now)}`);
    lines.push(`     ${c.dim('why')}   ${p.why}`);
    lines.push(`     ${c.green('start')} ${p.firstStep}`);
  });
  if (b.blocks.length) {
    lines.push('', `  ${c.bold('Plan')}`);
    for (const bl of b.blocks) {
      const label = bl.fixed ? c.dim(bl.label) : c.bold(bl.label);
      lines.push(`  ${c.dim(`${bl.start}-${bl.end}`)}  ${label}`);
    }
  }
  if (b.defer.length) {
    lines.push('', `  ${c.bold('Not today')}`);
    for (const x of b.defer) lines.push(`  ${c.dim(`#${x.taskId}`)} ${x.title} ${c.dim(`· ${x.reason}`)}`);
  }
  if (b.note) lines.push('', `  ${c.italic(b.note)}`);
  if (b.source === 'offline') lines.push('', c.dim('  (planned offline)'));
  return lines.join('\n');
}

export function renderWhere(r: RecallResult, now: number): string {
  if (!r.project) return `  ${r.lastState}`;
  const lines = [`  ${c.bold(c.cyan(r.project.slug))}${r.lastTouchedAt ? c.dim(`, last touched ${fmtWhen(r.lastTouchedAt, now)}`) : ''}`];
  lines.push(`  ${r.lastState}`);
  if (r.nextStep) lines.push(`  ${c.green('Next:')} ${c.bold(r.nextStep)}`);
  if (r.openLoops.length) {
    lines.push(`  ${c.dim('Open loops:')}`);
    for (const l of r.openLoops) lines.push(`    ${l.itemId ? c.dim(`#${l.itemId} `) : ''}${l.text}`);
  }
  if (r.note) lines.push(`  ${c.italic(r.note)}`);
  return lines.join('\n');
}

export function renderTasks(g: TaskGroups, now: number, slug: (id: number | null) => string | null): string {
  const lines: string[] = [];
  const section = (title: string, items: Item[], color: (s: string) => string) => {
    if (!items.length) return;
    lines.push(`  ${color(c.bold(title))}`);
    for (const t of items) {
      const p = slug(t.projectId);
      const snoozed = t.snoozedUntil && t.snoozedUntil > now ? c.dim(` (snoozed until ${fmtWhen(t.snoozedUntil, now)})`) : '';
      const when = t.dueAt === null && t.remindAt ? c.yellow(`remind ${fmtWhen(t.remindAt, now)}`) : dueLabel(t.dueAt, now);
      lines.push(`  ${c.dim(pad(`#${t.id}`, 5))} ${pad(t.title, 46)} ${stripAnsiPad(when, 24)} ${p ? c.cyan(p) : ''}${snoozed}`.trimEnd());
    }
    lines.push('');
  };
  section('Overdue', g.overdue, c.red);
  section('Today', g.today, c.yellow);
  section('This week', g.week, (s) => s);
  section('Later', g.later, c.dim);
  section('Someday', g.someday, c.dim);
  return lines.length ? lines.join('\n').trimEnd() : c.dim('  No open tasks. Nice.');
}

/** The two-line greeting cached in status.txt (always colored: it is cat'ed into a terminal). */
export function statusText(s: StatusSummary): string {
  const k = pc.createColors(true);
  const bits: string[] = [];
  if (s.next) bits.push(`next: ${s.next.title} ${k.dim(`(${fmtRelative(s.next.dueAt, s.now).replace('in ', 'due in ')})`)}`);
  if (s.overdue) bits.push(k.red(`${s.overdue} overdue`));
  if (s.briefReady) bits.push(k.green('brief ready'));
  if (!bits.length) bits.push(s.openTasks ? `${s.openTasks} open task${s.openTasks > 1 ? 's' : ''}` : 'all clear');
  const first = `${k.bold(k.magenta('hippo'))}  ${bits.join(k.dim(' · '))}`;
  const second = s.last ? `\n       ${k.dim('last:')} ${k.cyan(s.last.project)}, ${s.last.text}` : '';
  return `${first}${second}\n`;
}
