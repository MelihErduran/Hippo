// SQLite schema. Every timestamp is epoch milliseconds (INTEGER).
// Bump SCHEMA_VERSION and add a step to MIGRATIONS when this changes.

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captures (
  id           INTEGER PRIMARY KEY,
  text         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'cli',
  created_at   INTEGER NOT NULL,
  processed_at INTEGER,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_touched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('task','note','idea')),
  title         TEXT NOT NULL,
  body          TEXT,
  project_id    INTEGER REFERENCES projects(id),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  due_at        INTEGER,
  remind_at     INTEGER,
  snoozed_until INTEGER,
  estimate_min  INTEGER,
  capture_id    INTEGER REFERENCES captures(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS items_open ON items(status, kind, due_at);
CREATE INDEX IF NOT EXISTS items_project ON items(project_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  summary    TEXT NOT NULL,
  next_step  TEXT,
  capture_id INTEGER REFERENCES captures(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_project ON checkpoints(project_id, created_at);

-- Audit log. One "batch" = one dump or one command; undo reverses a batch.
CREATE TABLE IF NOT EXISTS actions (
  id         INTEGER PRIMARY KEY,
  batch      TEXT NOT NULL,
  agent      TEXT NOT NULL,
  type       TEXT NOT NULL,
  target_id  INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  before     TEXT,
  created_at INTEGER NOT NULL,
  undone_at  INTEGER
);
CREATE INDEX IF NOT EXISTS actions_batch ON actions(batch);

CREATE TABLE IF NOT EXISTS nudges (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL,
  step          TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('sent','skipped')),
  at            INTEGER NOT NULL,
  UNIQUE (item_id, step, scheduled_for)
);

CREATE TABLE IF NOT EXISTS briefs (
  date       TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  notified   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id            INTEGER PRIMARY KEY,
  agent         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ms            INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL,
  error         TEXT,
  created_at    INTEGER NOT NULL
);
`,
};
