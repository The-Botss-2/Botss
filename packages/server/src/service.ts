import {
  canTransition,
  defaultSettings,
  formatId,
  mergeSettings,
  parseConfigYaml,
  type Db,
  type DocStatus,
  type Phase,
  type Role,
  type Row,
  type Settings,
  type TaskKind,
  type TaskSpec,
  type TaskStatus,
} from "@botss/core";
import fs from "node:fs";
import type { BotssEvent, EventBus } from "./bus.ts";

// The one service layer. Every board state change goes through here: it writes the row, appends an
// `events` row, and publishes on the bus (which the WebSocket server broadcasts). Nothing else writes
// board state.

export class ServiceError extends Error {
  readonly code: 2 | 3 | 404 | 409;
  constructor(message: string, code: 2 | 3 | 404 | 409 = 2) {
    super(message);
    this.code = code;
  }
}

export interface ProjectState {
  paused: boolean;
  pauseReason?: string | null;
  limitedUntil?: number | null;
  idea?: { text: string; stakes?: string; attachments: string[]; links: string[]; kind?: string } | null;
  designChoice?: string | null;
  previewRunning?: boolean;
  alerts?: { id: number; ts: string; text: string; task?: string | null }[];
  changes?: ChangeRequest[];
}

/** An owner change request mid-project: PM updates the PRD, owner approves, tech lead replans, owner approves. */
export interface ChangeRequest {
  id: string;
  text: string;
  status: "pm" | "prd_review" | "replan" | "plan_review" | "applied" | "cancelled";
  created_at: string;
  updated_at: string;
  attachments: string[];
}

export interface EventMeta {
  actor?: string | null;
  role?: string | null;
  task?: string | null;
  run?: string | null;
}

const J = (v: unknown) => JSON.stringify(v ?? null);
function parseJ<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export interface TaskRow {
  id: string;
  kind: TaskKind;
  mode: string | null;
  title: string;
  role: Role;
  story: string | null;
  covers: string[];
  after: string[];
  owns: string[];
  may_touch: string[];
  verify: string;
  size: "S" | "M" | "L";
  body: string;
  source: string;
  status: TaskStatus;
  assignee: string | null;
  review_round: number;
  qa_round: number;
  verify_failures: number;
  run_failures: number;
  base_sha: string | null;
  head_sha: string | null;
  branch: string | null;
  worktree: string | null;
  session_id: string | null;
  blocked_on: string | null;
  blocked_reason: string | null;
  done_status: string | null;
  hold: string | null;
  priority: number;
  parent: string | null;
  meta: TaskMeta;
  created_at: string;
  updated_at: string;
}

export interface TaskMeta {
  /** Resume the given session with this prompt on the next run. */
  resume?: { session: string; prompt: string } | null;
  /** Extra prompt text for the next fresh run (e.g. review comments for the tech lead's ruling). */
  note?: string | null;
  /** Answer task: the message it must answer (first), and every message batched into it. */
  answers?: string;
  answersList?: string[];
  /** Planning task working on a change request. */
  changeId?: string;
  allowNetwork?: boolean;
  /** Integrate task: the task branch to merge in. */
  mergeBranch?: string;
  /** Status to return to after a blocking question is answered. */
  resumeStatus?: TaskStatus;
  lastVerify?: { code: number; output: string; at: string };
  [k: string]: unknown;
}

function toTask(r: Row): TaskRow {
  return {
    ...(r as any),
    covers: parseJ(r.covers, []),
    after: parseJ(r.after, []),
    owns: parseJ(r.owns, []),
    may_touch: parseJ(r.may_touch, []),
    meta: parseJ(r.meta, {}),
  } as TaskRow;
}

export class ProjectService {
  readonly id: string;
  readonly db: Db;
  private readonly bus: EventBus;
  constructor(id: string, db: Db, bus: EventBus) {
    this.id = id;
    this.db = db;
    this.bus = bus;
  }

  // ----------------------------------------------------------------------------------------- project

  ensureProject(name: string, root: string, configFile?: string): void {
    if (this.db.get("SELECT id FROM project WHERE id = 1")) return;
    let settings = defaultSettings();
    if (configFile && fs.existsSync(configFile)) {
      try {
        settings = mergeSettings(settings, parseConfigYaml(fs.readFileSync(configFile, "utf8")));
      } catch {
        /* keep defaults; doctor reports bad config */
      }
    }
    this.db.run("INSERT INTO project (id, name, root, phase, settings, state) VALUES (1, ?, ?, 'idea', ?, ?)", name, root, J(settings), J({ paused: false }));
  }

  project(): { name: string; root: string; phase: Phase; settings: Settings; state: ProjectState; created_at: string } {
    const r = this.db.get("SELECT * FROM project WHERE id = 1");
    if (!r) throw new ServiceError("project not initialized", 404);
    return {
      name: r.name,
      root: r.root,
      phase: r.phase as Phase,
      settings: mergeSettings(defaultSettings(), parseJ(r.settings, {})),
      state: parseJ<ProjectState>(r.state, { paused: false }),
      created_at: r.created_at,
    };
  }

  get phase(): Phase {
    return this.project().phase;
  }

  get settings(): Settings {
    return this.project().settings;
  }

  updateSettings(patch: Partial<Settings>, actor = "human"): Settings {
    const next = mergeSettings(this.settings, patch);
    this.db.run("UPDATE project SET settings = ? WHERE id = 1", J(next));
    this.emit("settings.updated", "Settings updated", { keys: Object.keys(patch) }, { actor });
    return next;
  }

  get state(): ProjectState {
    return this.project().state;
  }

  patchState(patch: Partial<ProjectState>): ProjectState {
    const next = { ...this.state, ...patch };
    this.db.run("UPDATE project SET state = ? WHERE id = 1", J(next));
    return next;
  }

  setPhase(phase: Phase, actor = "orchestrator"): void {
    const prev = this.phase;
    if (prev === phase) return;
    this.db.run("UPDATE project SET phase = ? WHERE id = 1", phase);
    this.emit("phase.changed", `Phase: ${prev} → ${phase}`, { from: prev, to: phase }, { actor });
  }

  alert(text: string, task?: string | null): void {
    const alerts = this.state.alerts ?? [];
    const a = { id: (alerts.at(-1)?.id ?? 0) + 1, ts: new Date().toISOString(), text, task: task ?? null };
    this.patchState({ alerts: [...alerts.slice(-49), a] });
    this.emit("alert.raised", text, { alert: a }, { task });
  }

  dismissAlert(id: number): void {
    this.patchState({ alerts: (this.state.alerts ?? []).filter((a) => a.id !== id) });
    this.emit("alert.dismissed", `Alert ${id} dismissed`, { id }, { actor: "human" });
  }

  // ------------------------------------------------------------------------------------------ events

  emit(type: string, summary: string, data: Record<string, unknown> = {}, meta: EventMeta = {}): BotssEvent {
    const r = this.db.run(
      "INSERT INTO events (type, actor, role, task, run_id, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      type,
      meta.actor ?? null,
      meta.role ?? null,
      meta.task ?? null,
      meta.run ?? null,
      summary,
      J(data),
    );
    const ev = this.db.get("SELECT * FROM events WHERE id = ?", r.lastInsertRowid)!;
    const out: BotssEvent = { ...(ev as any), data: parseJ(ev.data, {}) };
    this.bus.publish(this.id, out);
    return out;
  }

  events(opts: { after?: number; task?: string; limit?: number; types?: string[]; run?: string } = {}): BotssEvent[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.after) {
      where.push("id > ?");
      params.push(opts.after);
    }
    if (opts.task) {
      where.push("task = ?");
      params.push(opts.task);
    }
    if (opts.run) {
      where.push("run_id = ?");
      params.push(opts.run);
    }
    if (opts.types?.length) {
      where.push(`(${opts.types.map(() => "type LIKE ?").join(" OR ")})`);
      params.push(...opts.types.map((t) => (t.endsWith("*") ? `${t.slice(0, -1)}%` : t)));
    }
    const limit = Math.min(opts.limit ?? 500, 5000);
    const rows = this.db.all(
      `SELECT * FROM (SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}) ORDER BY id ASC`,
      ...params,
    );
    return rows.map((e) => ({ ...(e as any), data: parseJ(e.data, {}) }));
  }

  // ------------------------------------------------------------------------------------------- tasks

  task(id: string): TaskRow | null {
    const r = this.db.get("SELECT * FROM tasks WHERE id = ?", id);
    return r ? toTask(r) : null;
  }

  mustTask(id: string): TaskRow {
    const t = this.task(id);
    if (!t) throw new ServiceError(`unknown task ${id}`, 404);
    return t;
  }

  tasks(filter: { status?: string; role?: string; kind?: string[]; ready?: boolean } = {}): TaskRow[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.ready) where.push("status = 'ready'");
    if (filter.role) {
      where.push("role = ?");
      params.push(filter.role);
    }
    if (filter.kind?.length) {
      where.push(`kind IN (${filter.kind.map(() => "?").join(",")})`);
      params.push(...filter.kind);
    }
    return this.db
      .all(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, ...params)
      .map(toTask)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  createTask(
    t: Partial<TaskSpec> & { id: string; title: string; role: Role; kind: TaskKind; mode?: string | null; status?: TaskStatus; meta?: TaskMeta; priority?: number; parent?: string | null },
    actor = "orchestrator",
  ): TaskRow {
    if (this.task(t.id)) throw new ServiceError(`task ${t.id} already exists`, 409);
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO tasks (id, kind, mode, title, role, story, covers, after, owns, may_touch, verify, size, body, source, status, priority, parent, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id,
        t.kind,
        t.mode ?? null,
        t.title,
        t.role,
        t.story ?? null,
        J(t.covers ?? []),
        J(t.after ?? []),
        J(t.owns ?? []),
        J(t.may_touch ?? []),
        t.verify ?? "",
        t.size ?? "M",
        t.body ?? "",
        t.source ?? "",
        t.status ?? "todo",
        t.priority ?? 100,
        t.parent ?? null,
        J(t.meta ?? {}),
      );
      for (const d of t.after ?? []) this.db.run("INSERT OR IGNORE INTO task_deps (task, depends_on) VALUES (?, ?)", t.id, d);
    });
    this.emit("task.created", `${t.id} created: ${t.title}`, { kind: t.kind, role: t.role, mode: t.mode ?? null }, { actor, task: t.id, role: t.role });
    return this.mustTask(t.id);
  }

  updateTask(id: string, fields: Partial<Omit<TaskRow, "id" | "meta">> & { meta?: TaskMeta }): TaskRow {
    const sets: string[] = [];
    const params: any[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(["covers", "after", "owns", "may_touch", "meta"].includes(k) ? J(v) : (v as any));
    }
    if (sets.length) {
      sets.push("updated_at = ?");
      params.push(new Date().toISOString());
      this.db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    }
    return this.mustTask(id);
  }

  patchMeta(id: string, patch: Partial<TaskMeta>): TaskRow {
    const t = this.mustTask(id);
    const meta = { ...t.meta, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete meta[k];
    return this.updateTask(id, { meta });
  }

  setStatus(id: string, status: TaskStatus, opts: { actor?: string; reason?: string; force?: boolean; extra?: Partial<TaskRow> } = {}): TaskRow {
    const t = this.mustTask(id);
    if (!opts.force && !canTransition(t.status, status)) {
      throw new ServiceError(`task ${id} cannot move from ${t.status} to ${status}`, 409);
    }
    const updated = this.updateTask(id, { ...(opts.extra ?? {}), status });
    if (t.status !== status) {
      this.emit(
        "task.status",
        `${id} ${t.status} → ${status}${opts.reason ? `: ${opts.reason}` : ""}`,
        { from: t.status, to: status, reason: opts.reason ?? null },
        { actor: opts.actor ?? "orchestrator", task: id, role: t.role },
      );
    }
    return updated;
  }

  /** Replace not-yet-started build tasks with a newly validated plan. */
  /** `hold` marks newly imported tasks (a change request's replan) so they wait for the owner's approval. */
  importPlan(specs: TaskSpec[], actor: string, hold: string | null = null): void {
    const norm = (s: string | undefined) => (s ?? "").replace(/\r\n/g, "\n").trim();
    this.db.tx(() => {
      const existing = this.tasks({ kind: ["build"] });
      const started = existing.filter((t) => t.status !== "todo");
      if (started.length) {
        const keep = new Set(started.map((t) => t.id));
        const clash = specs.find((s) => keep.has(s.id) && norm(existing.find((e) => e.id === s.id)?.source) !== norm(s.source));
        if (clash) throw new ServiceError(`task ${clash.id} already started; create a new task ID instead of changing it`, 409);
      }
      for (const t of existing.filter((x) => x.status === "todo")) {
        this.db.run("DELETE FROM tasks WHERE id = ?", t.id);
        this.db.run("DELETE FROM task_deps WHERE task = ?", t.id);
      }
      for (const s of specs) {
        if (this.task(s.id)) continue;
        this.db.run(
          `INSERT INTO tasks (id, kind, title, role, story, covers, after, owns, may_touch, verify, size, body, source, status, priority, hold)
           VALUES (?, 'build', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`,
          s.id,
          s.title,
          s.role,
          s.story ?? null,
          J(s.covers),
          J(s.after),
          J(s.owns),
          J(s.may_touch),
          s.verify,
          s.size,
          s.body,
          s.source,
          s.id === "T000" ? 0 : s.id === "T001" ? 1 : 100,
          hold,
        );
        for (const d of s.after) this.db.run("INSERT OR IGNORE INTO task_deps (task, depends_on) VALUES (?, ?)", s.id, d);
      }
    });
    this.emit("plan.imported", `Plan imported: ${specs.length} tasks`, { tasks: specs.map((s) => s.id) }, { actor, role: "tech-lead" });
  }

  nextId(prefix: string, width = 3): string {
    return formatId(prefix, this.db.next(`task:${prefix}`), width);
  }

  // ------------------------------------------------------------------------------------------- docs

  docs(): Row[] {
    return this.db.all("SELECT * FROM documents ORDER BY name");
  }

  doc(name: string): (Row & { content: string | null; versions: Row[] }) | null {
    const d = this.db.get("SELECT * FROM documents WHERE name = ?", name);
    if (!d) return null;
    const versions = this.db.all("SELECT id, version, submitted_by, status, comments, created_at FROM document_versions WHERE doc = ? ORDER BY version", name);
    const latest = this.db.get("SELECT content FROM document_versions WHERE doc = ? ORDER BY version DESC LIMIT 1", name);
    return { ...d, content: latest?.content ?? null, versions: versions.map((v) => ({ ...v, comments: parseJ(v.comments, []) })) };
  }

  docVersion(name: string, version: number): Row | undefined {
    return this.db.get("SELECT * FROM document_versions WHERE doc = ? AND version = ?", name, version);
  }

  submitDoc(name: string, path: string, content: string, by: string, role: string | null, status: DocStatus = "submitted"): number {
    const version = this.db.tx(() => {
      const d = this.db.get("SELECT version FROM documents WHERE name = ?", name);
      const v = (d?.version ?? 0) + 1;
      if (d) this.db.run("UPDATE documents SET path = ?, status = ?, version = ?, updated_at = ? WHERE name = ?", path, status, v, new Date().toISOString(), name);
      else this.db.run("INSERT INTO documents (name, path, owner_role, status, version) VALUES (?, ?, ?, ?, ?)", name, path, role, status, v);
      this.db.run("INSERT INTO document_versions (doc, version, content, submitted_by, status) VALUES (?, ?, ?, ?, ?)", name, v, content, by, status);
      return v;
    });
    this.emit("doc.submitted", `${by} submitted ${name} v${version}`, { doc: name, version, status }, { actor: by, role });
    return version;
  }

  setDocStatus(name: string, status: DocStatus, comment: string | null, actor = "human"): void {
    const d = this.db.get("SELECT * FROM documents WHERE name = ?", name);
    if (!d) throw new ServiceError(`unknown document ${name}`, 404);
    this.db.run("UPDATE documents SET status = ?, updated_at = ? WHERE name = ?", status, new Date().toISOString(), name);
    const v = this.db.get("SELECT * FROM document_versions WHERE doc = ? AND version = ?", name, d.version);
    if (v) {
      const comments = parseJ<any[]>(v.comments, []);
      if (comment) comments.push({ by: actor, body: comment, ts: new Date().toISOString() });
      this.db.run("UPDATE document_versions SET status = ?, comments = ? WHERE id = ?", status, J(comments), v.id);
    }
    const verb = status === "approved" ? "approved" : status === "changes_requested" ? "requested changes on" : `marked ${status}`;
    this.emit(`doc.${status}`, `Owner ${verb} ${name} v${d.version}`, { doc: name, version: d.version, comment }, { actor });
  }

  commentDoc(name: string, body: string, anchor: string | null, actor = "human"): void {
    const d = this.db.get("SELECT * FROM documents WHERE name = ?", name);
    if (!d) throw new ServiceError(`unknown document ${name}`, 404);
    const v = this.db.get("SELECT * FROM document_versions WHERE doc = ? AND version = ?", name, d.version)!;
    const comments = parseJ<any[]>(v.comments, []);
    comments.push({ by: actor, body, anchor, ts: new Date().toISOString() });
    this.db.run("UPDATE document_versions SET comments = ? WHERE id = ?", J(comments), v.id);
    this.emit("doc.comment", `Comment on ${name}: ${body.slice(0, 80)}`, { doc: name, anchor }, { actor });
  }

  recordApproval(gate: string, doc: string | null, version: number | null, decision: string, comment: string | null): void {
    this.db.run("INSERT INTO approvals (gate, doc, version, decision, comment) VALUES (?, ?, ?, ?, ?)", gate, doc, version, decision, comment);
  }

  // --------------------------------------------------------------------------------------- messages

  message(from: { agent: string; role: string | null }, to: string, body: string, kind: "msg" | "ask" | "reply" | "batch" | "progress", opts: { task?: string | null; replyTo?: string | null; thread?: string | null } = {}): Row {
    const id = formatId("M", this.db.next("M"));
    const thread = opts.thread ?? (opts.replyTo ? (this.db.get("SELECT thread FROM messages WHERE id = ?", opts.replyTo)?.thread ?? opts.replyTo) : id);
    this.db.run(
      "INSERT INTO messages (id, from_agent, from_role, to_addr, body, kind, thread, reply_to, task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      from.agent,
      from.role,
      to,
      body,
      kind,
      thread,
      opts.replyTo ?? null,
      opts.task ?? null,
    );
    const label = kind === "ask" ? "asks" : kind === "reply" ? "replies to" : "→";
    this.emit(`${kind === "ask" || kind === "batch" ? "ask" : "msg"}.${kind}`, `${from.agent} ${label} ${to}: ${body.slice(0, 160)}`, { message: id, to, kind, body: body.slice(0, 2000) }, {
      actor: from.agent,
      role: from.role,
      task: opts.task ?? null,
    });
    return this.db.get("SELECT * FROM messages WHERE id = ?", id)!;
  }

  messages(opts: { task?: string; thread?: string; limit?: number } = {}): Row[] {
    if (opts.thread) return this.db.all("SELECT * FROM messages WHERE thread = ? ORDER BY created_at, id", opts.thread);
    if (opts.task) return this.db.all("SELECT * FROM messages WHERE task = ? ORDER BY created_at, id", opts.task);
    return this.db.all(`SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ${opts.limit ?? 300}) ORDER BY created_at, id`);
  }

  /** Messages addressed to this agent: by agent id, by role, or @team. */
  inbox(agent: string, role: string, opts: { all?: boolean; task?: string | null } = {}): Row[] {
    const rows = this.db.all(
      `SELECT * FROM messages WHERE (to_addr IN (?, ?, '@team') OR (task = ? AND ? = 1)) AND from_agent != ? ORDER BY created_at, id`,
      `@${agent}`,
      `@${role}`,
      opts.task ?? "",
      opts.all ? 1 : 0,
      agent,
    );
    return opts.all ? rows : rows.filter((r) => !parseJ<string[]>(r.read_by, []).includes(agent));
  }

  markRead(agent: string, ids: string[]): void {
    for (const id of ids) {
      const r = this.db.get("SELECT read_by FROM messages WHERE id = ?", id);
      if (!r) continue;
      const by = parseJ<string[]>(r.read_by, []);
      if (!by.includes(agent)) this.db.run("UPDATE messages SET read_by = ? WHERE id = ?", J([...by, agent]), id);
    }
  }

  // -------------------------------------------------------------------------------------- questions

  createQuestion(q: { messageId: string; from: string; to: string; task: string | null; runId: string | null; sessionId: string | null; body: string; batch?: unknown; kind?: string }): string {
    const id = formatId("Q", this.db.next("Q"));
    this.db.run(
      "INSERT INTO questions (id, message_id, from_agent, to_addr, task, run_id, session_id, kind, body, batch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      q.messageId,
      q.from,
      q.to,
      q.task,
      q.runId,
      q.sessionId,
      q.kind ?? (q.batch ? "batch" : "ask"),
      q.body,
      q.batch ? J(q.batch) : null,
    );
    return id;
  }

  question(id: string): Row | undefined {
    const q = this.db.get("SELECT * FROM questions WHERE id = ? OR message_id = ?", id, id);
    return q ? { ...q, batch: parseJ(q.batch, null), answer: parseJ(q.answer, q.answer) } : undefined;
  }

  questions(status?: string): Row[] {
    const rows = status ? this.db.all("SELECT * FROM questions WHERE status = ? ORDER BY created_at", status) : this.db.all("SELECT * FROM questions ORDER BY created_at");
    return rows.map((q) => ({ ...q, batch: parseJ(q.batch, null), answer: parseJ(q.answer, q.answer) }));
  }

  markAnswered(id: string, answer: unknown, by: string): void {
    this.db.run("UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?", typeof answer === "string" ? answer : J(answer), by, new Date().toISOString(), id);
  }

  // -------------------------------------------------------------------------------------- decisions

  addDecision(title: string, why: string, affects: string[], by: string, role: string | null, task: string | null): string {
    const id = formatId("D", this.db.next("D"), 3);
    this.db.run("INSERT INTO decisions (id, title, why, affects, by_agent, task) VALUES (?, ?, ?, ?, ?, ?)", id, title, why, J(affects), by, task);
    this.emit("decision.recorded", `${id}: ${title}`, { id, title, why, affects }, { actor: by, role, task });
    return id;
  }

  decisions(): Row[] {
    return this.db.all("SELECT * FROM decisions ORDER BY id").map((d) => ({ ...d, affects: parseJ(d.affects, []) }));
  }

  decision(id: string): Row | undefined {
    const d = this.db.get("SELECT * FROM decisions WHERE id = ?", id);
    return d ? { ...d, affects: parseJ(d.affects, []) } : undefined;
  }

  // ---------------------------------------------------------------------- handoffs, reviews, QA, bugs

  addHandoff(task: string, agent: string, status: string, content: string, verifyOutput: string | null, head: string | null): void {
    this.db.run("INSERT INTO handoffs (task, agent, status, content, verify_output, head_sha) VALUES (?, ?, ?, ?, ?, ?)", task, agent, status, content, verifyOutput, head);
    this.emit("handoff.submitted", `${agent} handed off ${task} (${status})`, { status }, { actor: agent, task });
  }

  handoffs(task: string): Row[] {
    return this.db.all("SELECT * FROM handoffs WHERE task = ? ORDER BY id", task);
  }

  openReview(task: string, round: number, reviewer: string): number {
    const existing = this.db.get("SELECT id FROM reviews WHERE task = ? AND round = ? AND verdict = 'pending'", task, round);
    if (existing) return existing.id as number;
    return this.db.run("INSERT INTO reviews (task, round, reviewer) VALUES (?, ?, ?)", task, round, reviewer).lastInsertRowid;
  }

  reviewComment(task: string, round: number, reviewer: string, c: { file?: string | null; line?: number | null; severity: string; body: string }): void {
    const rid = this.openReview(task, round, reviewer);
    this.db.run("INSERT INTO review_comments (review_id, task, file, line, severity, body) VALUES (?, ?, ?, ?, ?, ?)", rid, task, c.file ?? null, c.line ?? null, c.severity, c.body);
    this.emit("review.comment", `${reviewer} on ${task}${c.file ? ` ${c.file}${c.line ? `:${c.line}` : ""}` : ""} [${c.severity}]: ${c.body.slice(0, 140)}`, { ...c }, { actor: reviewer, role: "reviewer", task });
  }

  closeReview(task: string, round: number, reviewer: string, verdict: "approved" | "changes_requested", summary: string, content: string | null, role: string): void {
    const rid = this.openReview(task, round, reviewer);
    this.db.run("UPDATE reviews SET verdict = ?, summary = ?, content = ? WHERE id = ?", verdict, summary, content, rid);
    this.emit("review.verdict", `${reviewer} ${verdict === "approved" ? "approved" : "requested changes on"} ${task}: ${summary}`, { verdict, round, summary }, { actor: reviewer, role, task });
  }

  reviews(task: string): Row[] {
    return this.db.all("SELECT * FROM reviews WHERE task = ? ORDER BY round, id", task).map((r) => ({
      ...r,
      comments: this.db.all("SELECT * FROM review_comments WHERE review_id = ? ORDER BY id", r.id),
    }));
  }

  addQaReport(task: string, round: number, agent: string, verdict: "pass" | "fail", content: string): void {
    this.db.run("INSERT INTO qa_reports (task, round, agent, verdict, content) VALUES (?, ?, ?, ?, ?)", task, round, agent, verdict, content);
    this.emit(`qa.${verdict}`, `${agent}: QA ${verdict === "pass" ? "passed" : "failed"} ${task}`, { round }, { actor: agent, role: "qa", task });
  }

  qaReports(task: string): Row[] {
    return this.db.all("SELECT * FROM qa_reports WHERE task = ? ORDER BY id", task);
  }

  createBug(task: string, severity: string, title: string, content: string, by: string, role: string | null): string {
    const id = formatId("B", this.db.next("B"));
    this.db.run("INSERT INTO bugs (id, task, severity, title, content, reported_by) VALUES (?, ?, ?, ?, ?, ?)", id, task, severity, title, content, by);
    this.emit("bug.created", `${id} [${severity}] on ${task}: ${title}`, { id, severity, title }, { actor: by, role, task });
    return id;
  }

  bugs(task?: string, status?: string): Row[] {
    if (task && status) return this.db.all("SELECT * FROM bugs WHERE task = ? AND status = ? ORDER BY id", task, status);
    if (task) return this.db.all("SELECT * FROM bugs WHERE task = ? ORDER BY id", task);
    return this.db.all("SELECT * FROM bugs ORDER BY id");
  }

  closeBugs(task: string): void {
    this.db.run("UPDATE bugs SET status = 'fixed' WHERE task = ? AND status = 'open'", task);
  }

  // ------------------------------------------------------------------------------------- agents/runs

  agent(id: string): Row | undefined {
    return this.db.get("SELECT * FROM agents WHERE id = ?", id);
  }

  agents(): Row[] {
    return this.db.all("SELECT * FROM agents ORDER BY role, id");
  }

  upsertAgent(id: string, role: string, portBlock: number): Row {
    if (!this.agent(id)) {
      this.db.run("INSERT INTO agents (id, role, port_block, compose_project) VALUES (?, ?, ?, ?)", id, role, portBlock, `botss-${id}`);
      this.emit("agent.created", `Agent ${id} joined the team`, { role }, { actor: id, role });
    }
    return this.agent(id)!;
  }

  updateAgent(id: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.run(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k] as any), id);
  }

  run(id: string): Row | undefined {
    return this.db.get("SELECT * FROM runs WHERE id = ?", id);
  }

  runs(opts: { task?: string; active?: boolean; limit?: number } = {}): Row[] {
    if (opts.active) return this.db.all("SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at");
    if (opts.task) return this.db.all("SELECT * FROM runs WHERE task = ? ORDER BY started_at", opts.task);
    return this.db.all(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ${opts.limit ?? 200}`);
  }

  insertRun(r: { id: string; agent: string; role: string; task: string | null; stage: string; session_id: string; mode: string; cwd: string; token_hash: string }): void {
    this.db.run(
      "INSERT INTO runs (id, agent, role, task, stage, session_id, mode, cwd, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.id,
      r.agent,
      r.role,
      r.task,
      r.stage,
      r.session_id,
      r.mode,
      r.cwd,
      r.token_hash,
    );
  }

  updateRun(id: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.run(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => fields[k] as any), id);
  }

  /** Budget tokens used since local midnight. */
  usedToday(): number {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const r = this.db.get(
      "SELECT COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) AS n FROM runs WHERE started_at >= ?",
      since.toISOString(),
    );
    return Number(r?.n ?? 0);
  }

  usage(days = 7): { byDay: Row[]; byRole: Row[]; byTask: Row[]; today: number } {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));
    const s = since.toISOString();
    const sum = "SUM(input_tokens + output_tokens + cache_creation_tokens) AS tokens, SUM(cache_read_tokens) AS cache_read, SUM(cost_usd) AS cost, SUM(turns) AS turns, COUNT(*) AS runs";
    return {
      byDay: this.db.all(`SELECT substr(started_at, 1, 10) AS day, ${sum} FROM runs WHERE started_at >= ? GROUP BY day ORDER BY day`, s),
      byRole: this.db.all(`SELECT role, ${sum} FROM runs WHERE started_at >= ? GROUP BY role ORDER BY tokens DESC`, s),
      byTask: this.db.all(`SELECT task, ${sum} FROM runs WHERE started_at >= ? AND task IS NOT NULL GROUP BY task ORDER BY tokens DESC LIMIT 50`, s),
      today: this.usedToday(),
    };
  }

  avgTokensByRole(): Record<string, number> {
    const rows = this.db.all("SELECT role, AVG(input_tokens + output_tokens + cache_creation_tokens) AS avg FROM runs WHERE ended_at IS NOT NULL AND result_status = 'success' GROUP BY role");
    return Object.fromEntries(rows.filter((r) => r.avg > 0).map((r) => [r.role, Math.round(r.avg)]));
  }
}
