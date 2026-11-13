import { describe, expect, it } from 'vitest';
import { fileOffline, segment } from '../src/agents/filer-offline.js';
import { TsRanker } from '../src/rank/ranker.js';
import { parseLocalDateTime } from '../src/time.js';
import type { Item } from '../src/types.js';
import { T0 } from './helpers.js';

const EXAMPLE = 'cs161 hw4 due friday 11:59pm, ask navid about the esp32 wiring, idea: fl studio diff tool but for collabs. signalos: halfway through job queue refactor, next is the SKIP LOCKED test';

const ctx = (openTasks: { item: Item; project: string | null }[] = []) => ({
  now: T0, projects: [], openTasks, ranker: new TsRanker(),
});

const task = (id: number, title: string, project: string | null = null): { item: Item; project: string | null } => ({
  item: {
    id, kind: 'task', title, body: null, projectId: null, status: 'open', dueAt: null, remindAt: null,
    snoozedUntil: null, estimateMin: null, captureId: null, createdAt: T0, updatedAt: T0, completedAt: null,
  },
  project,
});

describe('segment', () => {
  it('splits sentences and comma lists but keeps checkpoints whole', () => {
    expect(segment(EXAMPLE)).toEqual([
      'cs161 hw4 due friday 11:59pm',
      'ask navid about the esp32 wiring',
      'idea: fl studio diff tool but for collabs',
      'signalos: halfway through job queue refactor, next is the SKIP LOCKED test',
    ]);
  });
  it('does not split short comma lists', () => {
    expect(segment('buy milk, eggs, bread')).toEqual(['buy milk, eggs, bread']);
  });
});

describe('fileOffline', () => {
  it('files the design-doc example into a task, a task, an idea and a checkpoint', () => {
    const out = fileOffline(EXAMPLE, ctx());
    expect(out.actions).toHaveLength(4);
    const [hw, ask, idea, cp] = out.actions;
    expect(hw).toMatchObject({ type: 'create_task', title: 'CS161 hw4', project: 'cs161' });
    // "friday" from Wed Nov 4 -> Fri Nov 6, 11:59 PM local
    expect(parseLocalDateTime((hw as { due: string }).due)).toBe(new Date(2026, 10, 6, 23, 59).getTime());
    expect(ask).toMatchObject({ type: 'create_task', title: 'Ask navid about the esp32 wiring', due: null });
    expect(idea).toMatchObject({ type: 'create_note', kind: 'idea', title: 'Fl studio diff tool but for collabs' });
    expect(cp).toMatchObject({ type: 'checkpoint', project: 'signalos', summary: 'Halfway through job queue refactor', next_step: 'The SKIP LOCKED test' });
  });

  it('turns "remind me" into a reminder, not a deadline', () => {
    const out = fileOffline('remind me at 5pm to call mom', ctx());
    expect(out.actions[0]).toMatchObject({ type: 'create_task', title: 'Call mom', due: null });
    expect(parseLocalDateTime((out.actions[0] as { remind_at: string }).remind_at)).toBe(new Date(2026, 10, 4, 17, 0).getTime());
  });

  it('completes a matching open task instead of creating one', () => {
    const out = fileOffline('done with the cs161 hw4', ctx([task(14, 'CS161 HW4', 'cs161'), task(15, 'Ask Navid about wiring')]));
    expect(out.actions).toEqual([{ type: 'complete_task', task_id: 14 }]);
  });

  it('keeps unknown text as a note and deadlines without a time at end of day', () => {
    const out = fileOffline('the wifi password at the lab is on the whiteboard\nsubmit epic assessment by monday', ctx());
    expect(out.actions[0]).toMatchObject({ type: 'create_note', kind: 'note' });
    expect(out.actions[1]).toMatchObject({ type: 'create_task', title: 'Submit epic assessment' });
    expect(parseLocalDateTime((out.actions[1] as { due: string }).due)).toBe(new Date(2026, 10, 9, 23, 59).getTime());
  });
});
