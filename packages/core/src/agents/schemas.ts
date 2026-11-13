import { z } from 'zod';

// What the models must return. Everything optional is `nullish` because models
// often send null for "not applicable".

const localTime = 'Local datetime "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" for end of that day. Use the calendar given.';

export const CreateTask = z.object({
  type: z.literal('create_task'),
  title: z.string().min(1).max(200).describe('Short imperative title in the user\'s words, about 3-8 words'),
  project: z.string().nullish().describe('Existing project slug if it fits, else a short new lowercase slug, else null'),
  due: z.string().nullish().describe(`Deadline. ${localTime} Only if the user gave one.`),
  remind_at: z.string().nullish().describe(`Only if the user asked to be reminded at a time. ${localTime}`),
  estimate_min: z.number().int().positive().max(2400).nullish().describe('Minutes, only if stated or obvious'),
  notes: z.string().nullish().describe('Extra detail worth keeping'),
});

export const CreateNote = z.object({
  type: z.literal('create_note'),
  kind: z.enum(['note', 'idea']).describe('idea = something to explore later; note = information to keep'),
  title: z.string().min(1).max(200),
  body: z.string().nullish(),
  project: z.string().nullish(),
});

export const CompleteTask = z.object({
  type: z.literal('complete_task'),
  task_id: z.number().int().describe('Id of an open task from the list. Only when the user clearly says it is done.'),
});

export const UpdateTask = z.object({
  type: z.literal('update_task'),
  task_id: z.number().int(),
  title: z.string().min(1).max(200).nullish(),
  due: z.string().nullish().describe(localTime),
  clear_due: z.boolean().nullish().describe('True to remove the due date. Use when they say the deadline is gone, not scheduled, or clear/remove the due.'),
  project: z.string().nullish(),
  estimate_min: z.number().int().positive().max(2400).nullish(),
});

export const DropItem = z.object({
  type: z.literal('drop_item'),
  item_id: z.number().int().describe('Id of a listed open task or note that is a duplicate or obsolete and should be removed'),
});

export const CheckpointAction = z.object({
  type: z.literal('checkpoint'),
  project: z.string().min(1),
  summary: z.string().min(1).describe('Where they are, in their words, past tense'),
  next_step: z.string().nullish().describe('The next concrete step if they said one'),
});

export const FilerAction = z.discriminatedUnion('type', [
  CreateTask, CreateNote, CompleteTask, UpdateTask, DropItem, CheckpointAction,
]);
export type FilerAction = z.infer<typeof FilerAction>;

export const FilerOutput = z.object({
  actions: z.array(FilerAction).max(40),
  reply: z.string().nullish().describe('Optional one short, warm line back to the user. No guilt.'),
});
export type FilerOutput = z.infer<typeof FilerOutput>;

export const PlannerOutput = z.object({
  headline: z.string().describe('One encouraging sentence about today. No guilt.'),
  top3: z.array(z.object({
    task_id: z.number().int(),
    why: z.string().describe('Why this one today, a few words'),
    first_step: z.string().describe('A concrete physical action that takes under 2 minutes to start'),
  })).max(3),
  blocks: z.array(z.object({
    start: z.string().describe('HH:MM, inside a free window'),
    end: z.string().describe('HH:MM'),
    task_id: z.number().int().nullish(),
    label: z.string(),
  })).max(12),
  defer: z.array(z.object({ task_id: z.number().int(), reason: z.string() })).max(10),
  note: z.string().nullish(),
});
export type PlannerOutput = z.infer<typeof PlannerOutput>;

export const RecallOutput = z.object({
  last_state: z.string().describe('1-2 sentences, second person, what they were doing'),
  next_step: z.string().describe('One concrete next action'),
  open_loops: z.array(z.object({ item_id: z.number().int().nullish(), text: z.string() })).max(8),
  note: z.string().nullish(),
});
export type RecallOutput = z.infer<typeof RecallOutput>;
