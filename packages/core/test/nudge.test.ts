import { describe, expect, it } from 'vitest';
import { inQuietHours, planNudges, type NudgePolicy } from '../src/nudge/policy.js';
import type { Item } from '../src/types.js';
import { DAY, FakeClock, HOUR, MIN, makeBrain } from './helpers.js';

const policy: NudgePolicy = {
  ladder: [24 * HOUR, 3 * HOUR, 30 * MIN],
  startBuffer: 1.5,
  quietStart: 23 * 60,
  quietEnd: 7 * 60,
  dailyCap: 8,
  remindGraceMs: 2 * HOUR,
};

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

function task(over: Partial<Item>): Item {
  return {
    id: 1, kind: 'task', title: 'CS161 HW4', body: null, projectId: null, status: 'open', dueAt: null, remindAt: null,
    snoozedUntil: null, estimateMin: null, captureId: null, createdAt: at(1, 9), updatedAt: at(1, 9), completedAt: null,
    ...over,
  };
}

const none = { recorded: () => false, sentToday: 0 };

describe('inQuietHours', () => {
  it('handles windows that wrap midnight', () => {
    expect(inQuietHours(at(4, 23, 30), policy)).toBe(true);
    expect(inQuietHours(at(4, 6, 59), policy)).toBe(true);
    expect(inQuietHours(at(4, 7, 0), policy)).toBe(false);
    expect(inQuietHours(at(4, 14, 0), policy)).toBe(false);
  });
});

describe('planNudges', () => {
  const due = at(6, 18, 0); // Fri 6 PM, so the steps fall outside quiet hours

  it('fires the ladder step whose time has come', () => {
    const p = planNudges([task({ dueAt: due })], due - 3 * HOUR + MIN, policy, none);
    expect(p.send.map((n) => n.step)).toEqual(['before-3h']);
    expect(p.send[0]!.message).toContain('due in 3h');
  });

  it('only fires the latest missed step after the laptop slept', () => {
    const p = planNudges([task({ dueAt: due })], due - 20 * MIN, policy, none);
    expect(p.send.map((n) => n.step)).toEqual(['before-30m']);
    expect(p.skip.map((n) => n.step).sort()).toEqual(['before-24h', 'before-3h']);
  });

  it('adds a start nudge from the estimate with the buffer', () => {
    const t = task({ dueAt: due, estimateMin: 240 }); // 240 min * 1.5 = 6h before due
    const p = planNudges([t], due - 6 * HOUR + MIN, policy, none);
    expect(p.send.map((n) => n.step)).toEqual(['start']);
    expect(p.send[0]!.message).toContain('Time to start');
  });

  it('holds during quiet hours and fires once they end', () => {
    const t = task({ dueAt: at(7, 10, 0) }); // Sat 10 AM; 3h step at 7 AM, 24h at Fri 10 AM
    const night = planNudges([t], at(7, 2, 0), policy, { recorded: (_i, s) => s === 'before-24h', sentToday: 0 });
    expect(night.send).toHaveLength(0);
    expect(night.held).toHaveLength(0); // 3h step (7 AM) not due yet at 2 AM
    const wake = planNudges([t], at(7, 7, 5), policy, { recorded: (_i, s) => s === 'before-24h', sentToday: 0 });
    expect(wake.send.map((n) => n.step)).toEqual(['before-3h']);
    const quietReminder = planNudges([task({ remindAt: at(6, 23, 30) })], at(6, 23, 40), policy, none);
    expect(quietReminder.held.map((n) => n.step)).toEqual(['remind']);
  });

  it('never nags after the deadline and skips stale reminders', () => {
    const p = planNudges([task({ dueAt: due })], due + HOUR, policy, none);
    expect(p.send).toHaveLength(0);
    expect(p.skip.length).toBe(3);
    const r = planNudges([task({ remindAt: at(4, 9) })], at(4, 12), policy, none);
    expect(r.skip.map((n) => n.step)).toEqual(['remind']);
  });

  it('ignores steps from before the task existed, respects snooze and the daily cap', () => {
    const fresh = task({ dueAt: due, createdAt: due - 2 * HOUR });
    expect(planNudges([fresh], due - 2 * HOUR + 5 * MIN, policy, none).send).toHaveLength(0);
    const snoozed = task({ dueAt: due, snoozedUntil: due - 10 * MIN });
    expect(planNudges([snoozed], due - 20 * MIN, policy, none).send).toHaveLength(0);
    const many = Array.from({ length: 5 }, (_, i) => task({ id: i + 1, dueAt: due + i * MIN }));
    const capped = planNudges(many, due - 20 * MIN, { ...policy, dailyCap: 3 }, { recorded: () => false, sentToday: 1 });
    expect(capped.send.map((n) => n.itemId)).toEqual([1, 2]); // most urgent first
    expect(capped.held).toHaveLength(3);
  });
});

describe('Brain.tick', () => {
  it('generates and announces the brief once, then sends nudges once', async () => {
    const clock = new FakeClock(at(4, 6, 50));
    const { brain } = makeBrain({ clock });
    await brain.capture('submit epic assessment today 10am');
    const sent: string[] = [];
    const notify = async (n: { title: string; body: string }) => { sent.push(`${n.title}: ${n.body}`); return true; };

    let r = await brain.tick(notify); // 6:50, before briefAt 7:30 and in quiet hours
    expect(r.briefGenerated).toBe(false);
    expect(sent).toHaveLength(0);

    clock.set(new Date(2026, 10, 4, 7, 31));
    r = await brain.tick(notify);
    expect(r.briefGenerated).toBe(true);
    expect(r.briefNotified).toBe(true);
    expect(r.sent.map((n) => n.step)).toEqual(['before-3h']);
    expect(sent[0]).toContain('Hippo: today');

    r = await brain.tick(notify);
    expect(r.briefNotified).toBe(false);
    expect(r.sent).toHaveLength(0);

    clock.set(new Date(2026, 10, 4, 9, 31));
    r = await brain.tick(notify);
    expect(r.sent.map((n) => n.step)).toEqual(['before-30m']);
    expect(sent).toHaveLength(3);
    clock.advance(DAY);
    expect((await brain.tick(notify)).sent).toHaveLength(0); // overdue: no nagging
  });
});
