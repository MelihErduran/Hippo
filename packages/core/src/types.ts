export type ItemKind = 'task' | 'note' | 'idea';
export type ItemStatus = 'open' | 'done' | 'dropped';

export interface Item {
  id: number;
  kind: ItemKind;
  title: string;
  body: string | null;
  projectId: number | null;
  status: ItemStatus;
  dueAt: number | null;
  remindAt: number | null;
  snoozedUntil: number | null;
  estimateMin: number | null;
  captureId: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface Project {
  id: number;
  slug: string;
  name: string;
  createdAt: number;
  lastTouchedAt: number;
}

export interface Checkpoint {
  id: number;
  projectId: number;
  summary: string;
  nextStep: string | null;
  captureId: number | null;
  createdAt: number;
}

export interface Capture {
  id: number;
  text: string;
  source: string;
  createdAt: number;
  processedAt: number | null;
  error: string | null;
}

export type ActionType =
  | 'create_item'
  | 'complete_item'
  | 'update_item'
  | 'delete_item'
  | 'create_checkpoint'
  | 'create_project';

export interface ActionRow {
  id: number;
  batch: string;
  agent: string;
  type: ActionType;
  targetId: number;
  payload: unknown;
  before: unknown;
  createdAt: number;
  undoneAt: number | null;
}

export interface BriefPick {
  taskId: number;
  title: string;
  why: string;
  firstStep: string;
  dueAt: number | null;
}

export interface BriefBlock {
  start: string; // HH:MM local
  end: string;
  label: string;
  taskId: number | null;
  fixed: boolean;
}

export interface BriefContent {
  date: string; // YYYY-MM-DD
  headline: string;
  top3: BriefPick[];
  blocks: BriefBlock[];
  defer: { taskId: number; title: string; reason: string }[];
  note: string | null;
  source: 'model' | 'offline';
  generatedAt: number;
}

export interface RecallResult {
  project: Project | null;
  lastTouchedAt: number | null;
  lastState: string;
  nextStep: string | null;
  openLoops: { itemId: number | null; text: string }[];
  note: string | null;
  source: 'model' | 'offline';
}

/** One line of "what happened" shown after a dump or command. */
export interface Applied {
  kind: 'task' | 'note' | 'idea' | 'checkpoint' | 'done' | 'update' | 'drop' | 'project';
  itemId?: number;
  title: string;
  project?: string | null;
  dueAt?: number | null;
  remindAt?: number | null;
}
