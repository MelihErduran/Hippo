import { describe, expect, it } from 'vitest';
import { applyActions } from '../src/agents/actions.js';
import { DAY, FakeClock, FakeProvider, HOUR, MIN, makeBrain } from './helpers.js';

const modelFiling = {
  actions: [
    { type: 'create_task', title: 'CS161 HW4', project: 'cs161', due: '2026-11-06T23:59', estimate_min: 120 },
    { type: 'create_task', title: 'Ask Navid about ESP32 wiring', project: 'smart-bin' },
    { type: 'create_note', kind: 'idea', title: 'FL Studio diff tool for collabs', project: 'fl-studio' },
    { type: 'checkpoint', project: 'signalos', summary: 'Halfway through the job queue refactor', next_step: 'Write the SKIP LOCKED test' },
  ],
  reply: 'Got it.',
};

describe('Brain.capture with a model', () => {
  it('saves the raw dump first, applies validated actions, and logs usage', async () => {
    const provider = new FakeProvider([modelFiling]);
    const { brain, store, mirror } = makeBrain({ provider });
    const r = await brain.capture('cs161 hw4 due friday 11:59pm, ask navid...');
    expect(r.source).toBe('model');
    expect(r.applied.filter((a) => a.kind !== 'project').map((a) => a.kind)).toEqual(['task', 'task', 'idea', 'checkpoint']);
    expect(store.listProjects().map((p) => p.slug).sort()).toEqual(['cs161', 'fl-studio', 'signalos', 'smart-bin']);
    expect(store.getCapture(r.captureId)!.processedAt).not.toBeNull();
    expect(store.llmUsage(0)[0]).toMatchObject({ model: 'fake-fast', calls: 1, inputTokens: 100 });
    // The prompt carries the calendar so the model never does date math.
    expect(provider.calls[0]!.prompt).toContain('Friday = 2026-11-06');
    expect(mirror.get('Tasks.md')).toContain('CS161 HW4');
    expect(mirror.get('Projects/signalos.md')).toContain('Write the SKIP LOCKED test');
  });

  it('reuses near-duplicate projects and drops actions that reference bad ids', async () => {
    const provider = new FakeProvider([
      modelFiling,
      {
        actions: [
          { type: 'create_task', title: 'Read chapter 5', project: 'CS 161' },
          { type: 'create_task', title: 'Lab report', project: 'cs162' },
          { type: 'complete_task', task_id: 999 },
          { type: 'create_task', title: 'Weird date', due: 'next blue moon' },
        ],
      },
    ]);
    const { brain, store } = makeBrain({ provider });
    await brain.capture('first');
    const r = await brain.capture('second');
    const slugs = store.listProjects().map((p) => p.slug);
    expect(slugs.filter((s) => s === 'cs161')).toHaveLength(1); // "CS 161" matched cs161
    expect(slugs).toContain('cs162'); // a different course is not merged
    expect(r.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('#999'),
      expect.stringContaining('next blue moon'),
    ]));
  });

  it('falls back to offline filing when the model call fails, and still files the dump', async () => {
    const provider = new FakeProvider([new Error('network down')]);
    const { brain, store } = makeBrain({ provider });
    const r = await brain.capture('submit epic assessment by monday');
    expect(r.source).toBe('offline');
    expect(r.fallbackReason).toBe('network down');
    expect(store.openTasks()[0]!.title).toBe('Submit epic assessment');
    expect(store.llmUsage(0)[0]).toMatchObject({ failures: 1 });
  });

  it('keeps a dump as a note when the model returns no actions', async () => {
    const { brain, store } = makeBrain({ provider: new FakeProvider([{ actions: [] }]) });
    await brain.capture('hmm');
    expect(store.allItems()[0]).toMatchObject({ kind: 'note', title: 'Hmm' });
  });
});

describe('undo', () => {
  it('reverses everything the last dump did, including new projects', async () => {
    const { brain, store } = makeBrain({ provider: new FakeProvider([modelFiling]) });
    await brain.capture('x');
    const r = brain.undo();
    expect(r.reverted.length).toBeGreaterThanOrEqual(8);
    expect(store.allItems()).toHaveLength(0);
    expect(store.listProjects()).toHaveLength(0);
    expect(store.latestCheckpoint()).toBeNull();
    expect(brain.undo().batch).toBeNull();
  });

  it('reopens a task completed with done, and restores a snooze', async () => {
    const { brain, store, clock } = makeBrain();
    await brain.capture('finish cs161 hw4 friday');
    const id = store.openTasks()[0]!.id;
    expect(brain.done('cs161 hw4')).toMatchObject({ status: 'done' });
    expect(store.openTasks()).toHaveLength(0);
    brain.undo();
    expect(store.openTasks()).toHaveLength(1);
    brain.snooze(id, clock.t + 2 * HOUR);
    expect(store.getItem(id)!.snoozedUntil).toBe(clock.t + 2 * HOUR);
    brain.undo();
    expect(store.getItem(id)!.snoozedUntil).toBeNull();
  });
});

describe('done', () => {
  it('asks when the words match several tasks equally', async () => {
    const { brain } = makeBrain();
    await brain.capture('email recruiter at epic\nemail recruiter at google');
    const r = brain.done('email recruiter');
    expect(r.status).toBe('ambiguous');
    expect(brain.done('#1')).toMatchObject({ status: 'done' });
    expect(brain.done('nothing like this')).toEqual({ status: 'none' });
  });
});

describe('park and where (offline)', () => {
  it('saves and recovers context for a project', async () => {
    const clock = new FakeClock();
    const { brain, store } = makeBrain({ clock });
    await brain.capture('signalos: fix the ingestion bug');
    const applied = brain.park('signalos: halfway through job queue refactor, next: write the SKIP LOCKED test');
    expect(applied.map((a) => a.kind)).toEqual(['checkpoint', 'update']);
    const task = store.openTasks().find((t) => store.getProject(t.projectId!)?.slug === 'signalos')!;
    expect(task.title).toBe('Write the SKIP LOCKED test');
    expect(task.body).toContain('Fix the ingestion bug');
    expect(task.body).toContain('- Halfway through job queue refactor');
    clock.advance(3 * HOUR);
    const r = await brain.where('signal os');
    expect(r.project?.slug).toBe('signalos');
    expect(r.lastState).toContain('Halfway through job queue refactor');
    expect(r.nextStep).toBe('Write the SKIP LOCKED test');
    expect(r.openLoops.map((l) => l.text)).toContain('Write the SKIP LOCKED test');
    // No argument: the project touched last.
    expect((await brain.where()).project?.slug).toBe('signalos');
  });

  it('rewrites only one open task when the checkpoint does not clearly match either', async () => {
    const clock = new FakeClock();
    const { brain, store } = makeBrain({ clock });
    await brain.capture('signalos: write the docs');
    clock.advance(MIN);
    await brain.capture('signalos: fix the ingestion bug');
    const before = store.itemsByProject(store.projectBySlug('signalos')!.id)
      .filter((i) => i.kind === 'task' && i.status === 'open');
    expect(before).toHaveLength(2);
    const primary = before[0]!; // updated_at DESC fallback
    const other = before[1]!;
    brain.park('signalos: halfway through job queue refactor, next: write the SKIP LOCKED test');
    expect(store.getItem(primary.id)!.title).toBe('Write the SKIP LOCKED test');
    expect(store.getItem(other.id)!.title).toBe(other.title);
  });

  it('rewrites the best-matching open task, not just the newest', () => {
    const clock = new FakeClock();
    const { brain, store } = makeBrain({ clock });
    const project = store.insertProject('cs147', 'cs147', clock.t);
    const solder = store.insertItem({
      kind: 'task', title: 'Solder sensor and check in with Navid', body: null, projectId: project.id,
      dueAt: null, remindAt: null, estimateMin: null, captureId: null, createdAt: clock.t,
    }, clock.t);
    clock.advance(MIN);
    const newest = store.insertItem({
      kind: 'task', title: 'Message professor about lab grade', body: null, projectId: project.id,
      dueAt: null, remindAt: null, estimateMin: null, captureId: null, createdAt: clock.t,
    }, clock.t);
    brain.park('cs147: worked on solder sensor with Navid, next: wait for Navid solder checkin');
    expect(store.getItem(solder.id)!.title).toBe('Wait for Navid solder checkin');
    expect(store.getItem(newest.id)!.title).toBe('Message professor about lab grade');
  });

  it('rewrites different open tasks for multiple checkpoints in one batch', async () => {
    const clock = new FakeClock();
    const { store } = makeBrain({ clock });
    const now = clock.t;
    const project = store.insertProject('cs147', 'cs147', now);
    const professor = store.insertItem({
      kind: 'task', title: 'Message professor about lab 2 grade', body: null, projectId: project.id,
      dueAt: null, remindAt: null, estimateMin: null, captureId: null, createdAt: now,
    }, now);
    clock.advance(MIN);
    const navid = store.insertItem({
      kind: 'task', title: 'Talk with Navid about extra lab time', body: null, projectId: project.id,
      dueAt: null, remindAt: null, estimateMin: null, captureId: null, createdAt: clock.t,
    }, clock.t);
    const applied = applyActions(store, 'test:multi-cp', 'user', null, [
      {
        type: 'create_checkpoint', project: { id: project.id },
        summary: 'Emailed the professor about lab checkoff', nextStep: 'Wait for professor reply',
      },
      {
        type: 'create_checkpoint', project: { id: project.id },
        summary: 'Messaged Navid about lab times', nextStep: 'Wait for Navid reply',
      },
    ], clock.t);
    expect(applied.filter((a) => a.kind === 'update')).toHaveLength(2);
    expect(store.getItem(professor.id)!.title).toBe('Wait for professor reply');
    expect(store.getItem(navid.id)!.title).toBe('Wait for Navid reply');
  });

  it('parks without rewriting when the project has no open tasks', async () => {
    const { brain, store } = makeBrain();
    const applied = brain.park('lonely: just thinking, next: start something');
    expect(applied.map((a) => a.kind)).toEqual(['project', 'checkpoint']);
    expect(store.openTasks()).toHaveLength(0);
    expect(store.latestCheckpoint()?.nextStep).toBe('Start something');
  });

  it('undo restores the primary task title and body after a park', async () => {
    const { brain, store } = makeBrain();
    await brain.capture('signalos: fix the ingestion bug');
    const id = store.openTasks()[0]!.id;
    const original = store.getItem(id)!;
    brain.park('signalos: halfway through job queue refactor, next: write the SKIP LOCKED test');
    expect(store.getItem(id)!.title).toBe('Write the SKIP LOCKED test');
    brain.undo();
    expect(store.latestCheckpoint()).toBeNull();
    expect(store.getItem(id)).toMatchObject({ title: original.title, body: original.body });
  });

  it('says so when nothing matches', async () => {
    const { brain } = makeBrain();
    expect((await brain.where('nope')).lastState).toContain('No project matches');
  });
});

describe('today (offline planner)', () => {
  it('picks overdue and due-soon work first and schedules around fixed blocks', async () => {
    const clock = new FakeClock(new Date(2026, 10, 4, 8, 0).getTime()); // Wed 8:00 AM
    const { brain } = makeBrain({
      clock,
      config: { schedule: { dayStart: '08:00', dayEnd: '22:00', blocks: [{ days: ['wed'], start: '09:00', end: '10:20', label: 'CS161 lecture' }] } },
    });
    await brain.capture('cs161 hw4 due today 11:59pm\nemail navid tomorrow\nread about tauri');
    clock.advance(DAY + 2 * HOUR); // Thu 10:00, hw4 is now overdue
    await brain.capture('apply to bedrock robotics');
    clock.set(new Date(2026, 10, 5, 8, 0)); // Thu 8:00
    const b = await brain.today();
    expect(b.top3[0]!.title).toBe('CS161 hw4'); // overdue first
    expect(b.top3).toHaveLength(3);
    expect(b.top3.every((p) => p.firstStep.length > 0)).toBe(true);
    expect(b.blocks.find((x) => x.fixed)).toBeUndefined(); // Thursday has no fixed blocks
    // Cached for the day unless fresh is asked for.
    expect((await brain.today()).generatedAt).toBe(b.generatedAt);
  });
});

describe('tasks', () => {
  it('keeps same-project tasks adjacent within a due bucket', async () => {
    const { brain, store } = makeBrain({
      provider: new FakeProvider([{
        actions: [
          { type: 'create_task', title: 'CS147 lab times', project: 'cs147' },
          { type: 'create_task', title: 'Buy milk', project: null },
          { type: 'create_task', title: 'CS162 midterm', project: 'cs162' },
          { type: 'create_task', title: 'CS147 solder', project: 'cs147' },
          { type: 'create_task', title: 'CS162 practice', project: 'cs162' },
        ],
      }]),
    });
    await brain.capture('tasks');
    const someday = brain.tasks().someday.map((t) =>
      t.projectId === null ? null : store.getProject(t.projectId)?.slug ?? null);
    expect(someday).toEqual(['cs147', 'cs147', 'cs162', 'cs162', null]);
  });
});

describe('filer corrections', () => {
  it('clears a due date when clear_due is set', async () => {
    const provider = new FakeProvider([
      {
        actions: [
          { type: 'create_task', title: 'Do CS 147 lab 2 makeup', project: 'cs147', due: '2026-11-06T09:30' },
        ],
      },
      {
        actions: [
          { type: 'update_task', task_id: 1, clear_due: true, title: 'Wait for professor to schedule lab 2 makeup' },
        ],
        reply: 'Due cleared.',
      },
    ]);
    const { brain, store } = makeBrain({ provider });
    await brain.capture('create');
    expect(store.getItem(1)!.dueAt).not.toBeNull();
    const r = await brain.capture('the lab 2 makeup has not been scheduled yet, so remove the due date on #1');
    expect(r.applied.some((a) => a.kind === 'update')).toBe(true);
    expect(store.getItem(1)!.dueAt).toBeNull();
    expect(store.getItem(1)!.title).toContain('Wait for professor');
  });

  it('drops a duplicate note and leaves the matching task', async () => {
    const provider = new FakeProvider([
      {
        actions: [
          { type: 'create_task', title: 'Do CS 147 lab 2 makeup', project: 'cs147' },
          { type: 'create_note', kind: 'note', title: 'Lab 2 makeup waiting on professor', project: 'cs147' },
        ],
      },
      {
        actions: [
          { type: 'update_task', task_id: 1, title: 'Wait for professor to schedule lab 2 makeup' },
          { type: 'drop_item', item_id: 2 },
        ],
      },
    ]);
    const { brain, store } = makeBrain({ provider });
    await brain.capture('create');
    const r = await brain.capture('for task number 1, it is the same as note #2');
    expect(r.applied.map((a) => a.kind)).toEqual(expect.arrayContaining(['update', 'drop']));
    expect(store.getItem(1)!.status).toBe('open');
    expect(store.getItem(2)!.status).toBe('dropped');
    expect(provider.calls[1]!.prompt).toContain('#2 (note)');
  });

  it('does not let a checkpoint rewrite a task already updated in the same dump', async () => {
    const provider = new FakeProvider([
      {
        actions: [
          { type: 'create_task', title: 'Solder sensor with Navid', project: 'cs147', due: '2026-11-06T09:30' },
        ],
      },
      {
        actions: [
          { type: 'update_task', task_id: 1, title: 'Show up at lab Friday 9:30 to solder' },
          {
            type: 'checkpoint', project: 'cs147',
            summary: 'Scheduled soldering with Navid',
            next_step: 'Do lab 2 and soldering together at 9:30',
          },
        ],
      },
    ]);
    const { brain, store } = makeBrain({ provider });
    await brain.capture('create');
    await brain.capture('friday plan');
    expect(store.getItem(1)!.title).toBe('Show up at lab Friday 9:30 to solder');
  });
});

describe('status', () => {
  it('summarizes next deadline, overdue count, and last checkpoint', async () => {
    const { brain, clock } = makeBrain();
    await brain.capture('submit lab report today 4pm\npay rent tomorrow 9am');
    brain.park('smart-bin: wired the ultrasonic sensor, next: test the lid servo');
    clock.advance(2 * HOUR); // 4:56 PM: lab report overdue
    const s = brain.status();
    expect(s.overdue).toBe(1);
    expect(s.next?.title).toBe('Pay rent');
    expect(s.last).toEqual({ project: 'smart-bin', text: 'next: Test the lid servo' });
    expect(MIN).toBe(60_000);
  });
});
