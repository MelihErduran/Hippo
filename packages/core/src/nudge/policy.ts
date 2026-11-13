import { HOUR, MINUTE, fmtRelative, fmtWhen, localMinutes, startOfLocalDay } from '../time.js';
import type { Item } from '../types.js';

// Deterministic nudge rules. Pure function of (tasks, now, history): nothing is
// pre-scheduled, so editing a due date or snoozing just works on the next tick.

export interface NudgePolicy {
  /** ms before the deadline, e.g. [24h, 3h, 30m] */
  ladder: number[];
  startBuffer: number;
  quietStart: number; // minutes since midnight
  quietEnd: number;
  dailyCap: number;
  remindGraceMs: number;
}

export interface Nudge {
  itemId: number;
  step: string;
  scheduledFor: number;
  title: string;
  message: string;
  urgency: number; // lower = more urgent
}

export interface NudgeHistory {
  recorded(itemId: number, step: string, scheduledFor: number): boolean;
  /** Notifications already sent today (local day). */
  sentToday: number;
}

export interface NudgePlan {
  send: Nudge[];
  /** Steps that will never fire (superseded or too late). Recorded so they are not reconsidered. */
  skip: Nudge[];
  /** Due now but held back (quiet hours or cap). Not recorded; reconsidered next tick. */
  held: Nudge[];
}

export function inQuietHours(now: number, p: Pick<NudgePolicy, 'quietStart' | 'quietEnd'>): boolean {
  const m = localMinutes(now);
  if (p.quietStart === p.quietEnd) return false;
  return p.quietStart < p.quietEnd ? m >= p.quietStart && m < p.quietEnd : m >= p.quietStart || m < p.quietEnd;
}

function ladderLabel(ms: number): string {
  return ms % HOUR === 0 ? `${ms / HOUR}h` : `${Math.round(ms / MINUTE)}m`;
}

export function planNudges(tasks: Item[], now: number, p: NudgePolicy, history: NudgeHistory): NudgePlan {
  const send: Nudge[] = [];
  const skip: Nudge[] = [];
  const held: Nudge[] = [];
  const quiet = inQuietHours(now, p);

  for (const t of tasks) {
    if (t.kind !== 'task' || t.status !== 'open') continue;
    if (t.snoozedUntil && t.snoozedUntil > now) continue;
    // Steps scheduled before the task existed are meaningless: you just wrote it down.
    const born = t.createdAt + MINUTE;
    const candidates: Nudge[] = [];

    if (t.remindAt && t.remindAt >= born && t.remindAt <= now) {
      const n: Nudge = {
        itemId: t.id, step: 'remind', scheduledFor: t.remindAt, title: t.title,
        message: `Reminder: ${t.title}`, urgency: 0,
      };
      if (!history.recorded(t.id, n.step, n.scheduledFor)) {
        if (now - t.remindAt > p.remindGraceMs) skip.push(n);
        else if (quiet) held.push(n);
        else candidates.push(n);
      }
    }

    if (t.dueAt) {
      const steps: Nudge[] = [];
      for (const before of p.ladder) {
        steps.push({
          itemId: t.id, step: `before-${ladderLabel(before)}`, scheduledFor: t.dueAt - before, title: t.title,
          message: `${t.title} due ${fmtRelative(t.dueAt, now)} (${fmtWhen(t.dueAt, now)})`,
          urgency: t.dueAt - now,
        });
      }
      if (t.estimateMin) {
        const est = t.estimateMin * MINUTE * p.startBuffer;
        steps.push({
          itemId: t.id, step: 'start', scheduledFor: t.dueAt - est, title: t.title,
          message: `Time to start ${t.title}. Due ${fmtRelative(t.dueAt, now)}, about ${t.estimateMin} min of work.`,
          urgency: t.dueAt - now,
        });
      }
      const pending = steps
        .filter((s) => s.scheduledFor >= born && s.scheduledFor <= now && !history.recorded(t.id, s.step, s.scheduledFor))
        .sort((a, b) => b.scheduledFor - a.scheduledFor);
      if (pending.length) {
        const [latest, ...older] = pending;
        skip.push(...older); // missed while asleep or snoozed: only the latest fires
        if (now >= t.dueAt) skip.push(latest!); // deadline passed: the brief handles overdue, no nagging
        else if (quiet) held.push(latest!);
        else candidates.push(latest!);
      }
    }
    send.push(...candidates);
  }

  // Daily cap: most urgent first, the rest wait.
  send.sort((a, b) => a.urgency - b.urgency);
  const room = Math.max(0, p.dailyCap - history.sentToday);
  return { send: send.slice(0, room), skip, held: [...held, ...send.slice(room)] };
}

export function startOfToday(now: number): number {
  return startOfLocalDay(now);
}
