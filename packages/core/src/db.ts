import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// SQLite via Node's built-in `node:sqlite` (see docs/decisions/0001-node-sqlite.md). Plain SQL migrations,
// applied in order and recorded in `schema_migrations`.

export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "initial",
    sql: `
CREATE TABLE project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'idea',
  settings TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE documents (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  owner_role TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL REFERENCES documents(name),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  submitted_by TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  comments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (doc, version)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'build',
  mode TEXT,
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  story TEXT,
  covers TEXT NOT NULL DEFAULT '[]',
  after TEXT NOT NULL DEFAULT '[]',
  owns TEXT NOT NULL DEFAULT '[]',
  may_touch TEXT NOT NULL DEFAULT '[]',
  verify TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT 'M',
  body TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  assignee TEXT,
  review_round INTEGER NOT NULL DEFAULT 0,
  qa_round INTEGER NOT NULL DEFAULT 0,
  verify_failures INTEGER NOT NULL DEFAULT 0,
  run_failures INTEGER NOT NULL DEFAULT 0,
  base_sha TEXT,
  head_sha TEXT,
  branch TEXT,
  worktree TEXT,
  session_id TEXT,
  blocked_on TEXT,
  blocked_reason TEXT,
  done_status TEXT,
  hold TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  parent TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE task_deps (
  task TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task, depends_on)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  current_task TEXT,
  current_run TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  port_block INTEGER NOT NULL,
  compose_project TEXT NOT NULL,
  last_action TEXT,
  last_file TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  role TEXT NOT NULL,
  task TEXT,
  stage TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  pid INTEGER,
  cwd TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  exit_code INTEGER,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  result_status TEXT,
  result_text TEXT,
  last_action TEXT,
  last_file TEXT,
  token_hash TEXT
);
CREATE INDEX runs_task ON runs(task);
CREATE INDEX runs_started ON runs(started_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  from_role TEXT,
  to_addr TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'msg',
  thread TEXT,
  reply_to TEXT,
  task TEXT,
  read_by TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  from_agent TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  task TEXT,
  run_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL DEFAULT 'ask',
  body TEXT NOT NULL,
  batch TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  answered_at TEXT
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  affects TEXT NOT NULL DEFAULT '[]',
  by_agent TEXT,
  task TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  agent TEXT,
  status TEXT NOT NULL,
  content TEXT NOT NULL,
  verify_output TEXT,
  head_sha TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  round INTEGER NOT NULL,
  reviewer TEXT,
  verdict TEXT NOT NULL DEFAULT 'pending',
  summary TEXT,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id),
  task TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  severity TEXT NOT NULL DEFAULT 'minor',
  body TEXT NOT NULL,
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE qa_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent TEXT,
  verdict TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE bugs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  reported_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type TEXT NOT NULL,
  actor TEXT,
  role TEXT,
  task TEXT,
  run_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_task ON events(task);
CREATE INDEX events_type ON events(type);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gate TEXT NOT NULL,
  doc TEXT,
  version INTEGER,
  decision TEXT NOT NULL,
  comment TEXT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`,
  },
  {
    id: 2,
    name: "live progress: agent plans and activities",
    sql: `
ALTER TABLE runs ADD COLUMN todos TEXT;
ALTER TABLE runs ADD COLUMN activity TEXT;
ALTER TABLE agents ADD COLUMN activity TEXT;
`,
  },
  {
    id: 3,
    name: "learning memory",
    sql: `
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  paths TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  by_agent TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`,
  },
];

export type Row = Record<string, any>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    const done = new Set(this.all("SELECT id FROM schema_migrations").map((r) => r.id as number));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", m.id, m.name, new Date().toISOString());
      });
    }
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.raw.prepare(sql).get(...params) as Row | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  /** Next value of a named counter, e.g. M (messages) -> 1, 2, 3. */
  next(name: string): number {
    this.run("INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1", name);
    return this.get("SELECT value FROM counters WHERE name = ?", name)!.value as number;
  }

  close(): void {
    this.raw.close();
  }
}
