import {
  authorize,
  checkPlan,
  DONE_STATUSES,
  docOwners,
  isRole,
  matchesAny,
  planStats,
  SEVERITIES,
  type Action,
  type DoneStatus,
  type Identity,
  type Role,
} from "@botss/core";
import fs from "node:fs";
import path from "node:path";
import { diffNames, headSha, lsFiles, statusPorcelain } from "./git.ts";
import type { Project } from "./project.ts";
import { ServiceError, type TaskRow } from "./service.ts";
import { runShell } from "./shell.ts";
import { walkFiles } from "./snapshot.ts";

// Semantics of every agent command in skills/team-protocol/references/botss-cli.md. The CLI is a thin client:
// it reads scratch files locally and sends their content; all checks and state changes happen here.

export interface CmdResult {
  text: string;
  data?: unknown;
  /** Non-zero: the command was refused (verify failed, dirty tree, ...). */
  exit?: number;
}

const STANDARD_DOCS: Record<string, string> = {
  prd: ".botss/docs/prd.md",
  architecture: ".botss/docs/architecture.md",
  design: ".botss/docs/design/DESIGN.md",
  plan: ".botss/docs/plan-summary.md",
  idea: ".botss/docs/idea.md",
  codebase: ".botss/docs/codebase.md",
  triage: ".botss/docs/triage.md",
  release: ".botss/docs/release.md",
};

export function docPath(name: string): string {
  if (STANDARD_DOCS[name]) return STANDARD_DOCS[name]!;
  if (/^(contracts|decisions|security|qa|discovery|design)\/[A-Za-z0-9._\-/]+$/.test(name) && !name.includes("..")) {
    return `.botss/docs/${name}${name.startsWith("decisions/") && !name.endsWith(".md") ? ".md" : ""}`;
  }
  throw new ServiceError(`unknown document "${name}". Known: prd, architecture, contracts/<file>, design, plan, decisions/<id>`, 2);
}

/** Messages are read by other agents (and paid for in their context). Detail belongs in a file. */
const MAX_MESSAGE = 2000;
function checkLength(body: string, what: string): void {
  if (body.length > MAX_MESSAGE) {
    throw new ServiceError(
      `${what} is ${body.length} characters; the limit is ${MAX_MESSAGE}. Put the detail in a file (a contract, a decision, or .botss/reviews/<name>.md) and send its path in a short message.`,
      2,
    );
  }
}

const ASK_NOTICE ="Question posted. Your task is paused. Finish your run now with a one-line summary; you will be resumed with the answer.";

export class Commands {
  private readonly p: Project;
  constructor(p: Project) {
    this.p = p;
  }

  private get svc() {
    return this.p.svc;
  }

  private must(id: Identity, action: Action, ctx: { task?: string; doc?: string } = {}): void {
    const d = authorize(id, action, ctx);
    if (!d.ok) throw new ServiceError(d.reason ?? "not allowed", 3);
  }

  private actor(id: Identity): { agent: string; role: string | null } {
    return id.kind === "human" ? { agent: "human", role: null } : { agent: id.agent, role: id.role };
  }

  /** The task an identity's run belongs to (planning runs have no BOTSS_TASK but do have a P- task). */
  private runTask(id: Identity): string | null {
    if (id.kind === "human") return null;
    return id.task ?? (this.svc.run(id.runId)?.task as string | undefined) ?? null;
  }

  // ---------------------------------------------------------------------------------- orientation

  /** Files in the project, for the conservative ownership-collision check. */
  private async projectFiles(): Promise<string[]> {
    return this.p.direct ? walkFiles(this.p.paths.root) : lsFiles(this.p.paths.integration);
  }

  whoami(id: Identity): CmdResult {
    if (id.kind === "human") return { text: "agent: human (owner)", data: { agent: "human", role: null } };
    const t = id.task ? this.svc.task(id.task) : null;
    const run = this.svc.run(id.runId);
    const wt = t?.worktree ?? run?.cwd ?? "";
    const lines = [`agent: ${id.agent}   role: ${id.role}`];
    if (t) lines.push(`task: ${t.id} "${t.title}"`);
    else lines.push(`task: (none) mode: ${run ? this.svc.task(run.task)?.mode ?? "" : ""}`);
    lines.push(`worktree: ${wt}   branch: ${t?.branch ?? "botss/integration"}`);
    return { text: lines.join("\n"), data: { agent: id.agent, role: id.role, task: t?.id ?? null, title: t?.title ?? null, worktree: wt, branch: t?.branch ?? "botss/integration", run: id.runId } };
  }

  taskShow(id: Identity, taskId: string): CmdResult {
    this.must(id, "read");
    const t = this.svc.mustTask(taskId);
    const reviews = this.svc.reviews(t.id);
    const bugs = this.svc.bugs(t.id, "open");
    const handoffs = this.svc.handoffs(t.id);
    const qa = this.svc.qaReports(t.id);
    const thread = this.svc.messages({ task: t.id });
    const out: string[] = [];
    out.push(`${t.id} [${t.status}${t.hold ? `, hold: ${t.hold}` : ""}] ${t.title}`);
    out.push(`role: ${t.role}   kind: ${t.kind}   assignee: ${t.assignee ?? "-"}   review round: ${t.review_round}   qa round: ${t.qa_round}`);
    if (t.branch) out.push(`branch: ${t.branch}   worktree: ${t.worktree ?? "-"}   base: ${t.base_sha?.slice(0, 7) ?? "-"}`);
    if (t.blocked_reason) out.push(`blocked on ${t.blocked_on}: ${t.blocked_reason}`);
    out.push("", t.source || `## ${t.title}\n\nowns: ${t.owns.join(", ")}\nverify: ${t.verify}\n\n${t.body}`);
    const lastReview = reviews.filter((r) => r.verdict !== "pending").at(-1);
    if (lastReview) {
      out.push("", `## Review notes (round ${lastReview.round}: ${lastReview.verdict})`, "", lastReview.summary ?? "");
      for (const c of lastReview.comments) out.push(`- [${c.severity}] ${c.file ? `${c.file}${c.line ? `:${c.line}` : ""} ` : ""}${c.body}`);
      if (lastReview.content) out.push("", lastReview.content);
    }
    if (bugs.length) {
      out.push("", "## Open bugs");
      for (const b of bugs) out.push(`- ${b.id} [${b.severity}] ${b.title}${b.content ? `\n  ${b.content.split("\n").join("\n  ")}` : ""}`);
    }
    if (qa.length) out.push("", `## Last QA report (${qa.at(-1)!.verdict})`, "", qa.at(-1)!.content);
    if (handoffs.length) out.push("", `## Last handoff (${handoffs.at(-1)!.status})`, "", handoffs.at(-1)!.content);
    if (t.meta.lastVerify && t.meta.lastVerify.code !== 0) out.push("", `## Last verify failed (exit ${t.meta.lastVerify.code})`, "```", t.meta.lastVerify.output.slice(-3000), "```");
    if (thread.length) {
      out.push("", "## Messages on this task");
      for (const m of thread) out.push(`- ${m.id} ${m.from_agent} → ${m.to_addr} (${m.kind}): ${m.body}`);
    }
    return { text: out.join("\n"), data: { task: t, reviews, bugs, handoffs, qa, messages: thread } };
  }

  taskList(id: Identity, f: { ready?: boolean; role?: string; status?: string }): CmdResult {
    this.must(id, "read");
    const rows = this.svc.tasks({ ready: f.ready, role: f.role, status: f.status, kind: ["build", "integrate", "release"] });
    const text = rows.length ? rows.map((t) => `${t.id.padEnd(7)} ${t.status.padEnd(17)} ${t.role.padEnd(10)} ${t.assignee ?? "-"}  ${t.title}`).join("\n") : "(no tasks)";
    return { text, data: rows.map(({ source: _s, body: _b, ...rest }) => rest) };
  }

  taskStart(id: Identity, taskId: string): CmdResult {
    this.must(id, "task.own", { task: taskId });
    const t = this.svc.mustTask(taskId);
    if (t.status === "in_progress") return { text: `${t.id} already in progress` };
    if (!["ready", "changes_requested"].includes(t.status)) throw new ServiceError(`${t.id} is ${t.status}; only ready or changes_requested tasks can be started`, 2);
    this.svc.setStatus(t.id, "in_progress", { actor: this.actor(id).agent, extra: { assignee: id.kind === "agent" ? id.agent : t.assignee } });
    return { text: `${t.id} in progress` };
  }

  progress(id: Identity, text: string): CmdResult {
    this.must(id, "progress");
    if (!text.trim()) throw new ServiceError("progress text is empty", 2);
    const a = this.actor(id);
    this.svc.emit("progress.note", text.trim().slice(0, 500), {}, { actor: a.agent, role: a.role, task: this.runTask(id), run: id.kind === "agent" ? id.runId : null });
    return { text: "posted" };
  }

  taskBlock(id: Identity, taskId: string, on: string, reason: string): CmdResult {
    this.must(id, "task.own", { task: taskId });
    if (!on || !reason) throw new ServiceError("task block needs --on <who> and --reason <text>", 2);
    const t = this.svc.mustTask(taskId);
    this.blockWithQuestion(id, t, on, reason, "ask");
    return { text: `${t.id} blocked on ${on}. ${ASK_NOTICE}` };
  }

  taskUnblock(id: Identity, taskId: string): CmdResult {
    this.must(id, "task.unblock", { task: taskId });
    const t = this.svc.mustTask(taskId);
    if (t.status !== "blocked") return { text: `${t.id} is not blocked` };
    this.svc.setStatus(t.id, t.meta.resumeStatus ?? "in_progress", { force: true, actor: this.actor(id).agent, extra: { blocked_on: null, blocked_reason: null, hold: null } });
    this.svc.patchMeta(t.id, { resumeStatus: undefined });
    return { text: `${t.id} unblocked` };
  }

  async taskDone(id: Identity, taskId: string, status: string, handoff: string | null): Promise<CmdResult> {
    this.must(id, "task.own", { task: taskId });
    if (!(DONE_STATUSES as readonly string[]).includes(status)) throw new ServiceError(`--status must be one of ${DONE_STATUSES.join(", ")} (a blocked task uses \`botss task block\`)`, 2);
    if (!handoff?.trim()) throw new ServiceError("--handoff <file> is required and must not be empty (write it to .botss/handoffs/<task>.md)", 2);
    const t = this.svc.mustTask(taskId);
    if (!["in_progress", "ready", "changes_requested"].includes(t.status)) throw new ServiceError(`${t.id} is ${t.status}; only a task in progress can be handed off`, 2);
    const actor = this.actor(id).agent;
    const direct = this.p.direct;
    const cwd = direct ? this.p.paths.root : (t.worktree ?? this.svc.run(id.kind === "agent" ? id.runId : "")?.cwd);
    if (!cwd || !fs.existsSync(cwd)) throw new ServiceError(`no worktree for ${t.id}`, 2);

    // 1. Isolated mode: owned work must be committed (scratch folders excluded). Direct mode has no commits.
    const owned = [...t.owns, ...t.may_touch];
    const dirty = direct
      ? []
      : (await statusPorcelain(cwd)).filter((f) => !f.file.startsWith(".botss/handoffs/") && !f.file.startsWith(".botss/reviews/") && !f.file.startsWith(".botss/screens/") && matchesAny(owned, f.file));
    if (dirty.length) {
      return { exit: 1, text: `Refused: commit your owned work first. Uncommitted:\n${dirty.map((d) => `  ${d.code} ${d.file}`).join("\n")}` };
    }
    // Backstop for edits the hook cannot see (for example a shell redirect): the branch diff must stay inside
    // the task's paths. Integrate tasks merge whole task branches, so they are exempt.
    if (!direct && t.base_sha && t.kind !== "integrate") {
      const role = (id.kind === "agent" ? id.role : t.role) as Role;
      const allowed = this.p.orch.writableFor(t, role, "implement");
      const outside = (await diffNames(cwd, t.base_sha)).filter((f) => !matchesAny(allowed, f));
      if (outside.length) {
        return {
          exit: 1,
          text: `Refused: your branch changes files outside this task's paths:\n${outside.map((f) => `  ${f}`).join("\n")}\nRevert them (git checkout ${t.base_sha.slice(0, 7)} -- <file>) or ask the tech lead to change the task's owns.`,
        };
      }
    }
    // 2. Ingest the handoff.
    const head = direct ? null : await headSha(cwd);
    // 3. Verify for DONE / DONE_WITH_CONCERNS.
    let verifyOut: string | null = null;
    if (status !== "NEEDS_CONTEXT" && t.verify.trim()) {
      const agent = id.kind === "agent" ? id.agent : (t.assignee ?? `${t.role}-1`);
      const env = this.svc.agent(agent) ? this.p.orch.envFor(agent, { BOTSS_TASK: t.id, BOTSS_WORKTREE: cwd, BOTSS_ROOT: this.p.paths.root }) : { ...process.env as Record<string, string> };
      this.svc.emit("task.verify", `${t.id}: running verify \`${t.verify.slice(0, 120)}\``, {}, { actor, task: t.id });
      const r = await runShell(t.verify, { cwd, env, timeoutMs: this.svc.settings.verify_timeout_minutes * 60_000 });
      verifyOut = r.output;
      this.svc.patchMeta(t.id, { lastVerify: { code: r.code, output: r.output.slice(-6000), at: new Date().toISOString() } });
      if (r.code !== 0) {
        const fails = t.verify_failures + 1;
        this.svc.updateTask(t.id, { verify_failures: fails });
        this.svc.addHandoff(t.id, actor, `${status} (verify failed)`, handoff, verifyOut, head);
        this.svc.emit("task.verify_failed", `${t.id}: verify failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}), attempt ${fails}`, { code: r.code, output: r.output.slice(-2000) }, { actor, task: t.id });
        if (fails >= this.svc.settings.max_verify_failures) {
          this.svc.setStatus(t.id, "blocked", { force: true, reason: `verify failed ${fails} times in a row`, extra: { blocked_on: "@human", blocked_reason: "verify keeps failing" } });
          this.svc.alert(`${t.id} failed verify ${fails} times in a row and is blocked. Look at the task's verify output.`, t.id);
          return { exit: 1, text: `Refused: verify failed (exit ${r.code}). This was attempt ${fails}; the task is now blocked for the owner.\n\n${r.output}` };
        }
        return { exit: 1, text: `Refused: verify failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}). Fix it and run \`botss task done\` again.\n\n$ ${t.verify}\n${r.output}` };
      }
    }
    this.svc.addHandoff(t.id, actor, status, handoff, verifyOut, head);
    this.svc.updateTask(t.id, { verify_failures: 0, head_sha: head, done_status: status });

    if (status === "NEEDS_CONTEXT") {
      this.blockWithQuestion(id, t, "@tech-lead", `${t.id} needs context before it can be finished. Handoff:\n\n${handoff}`, "ask");
      return { text: `${t.id} handed off as NEEDS_CONTEXT; it is blocked until the tech lead answers. Finish your run now.` };
    }
    if (status === "DONE_WITH_CONCERNS") this.svc.emit("task.concerns", `${t.id} done with concerns`, {}, { actor, task: t.id });

    if (t.kind === "build" && t.meta.fast) {
      // Quick track: verified is enough; no review or QA round.
      this.svc.setStatus(t.id, "review", { actor, force: true, reason: `${status} (quick track)` });
      void this.p.orch.queueMerge(t.id);
      return { text: `${t.id} verified. Quick track: it is done.` };
    }
    if (t.kind === "build" && !t.meta.ruling) {
      this.svc.setStatus(t.id, "review", { actor, reason: status });
      return { text: `${t.id} verified and moved to review.` };
    }
    if (t.kind === "build" && t.meta.ruling) {
      this.svc.patchMeta(t.id, { ruling: undefined });
      this.svc.setStatus(t.id, this.svc.settings.qa_per_task ? "qa" : "review", { actor, force: true, reason: "tech lead ruling" });
      if (!this.svc.settings.qa_per_task) void this.p.orch.queueMerge(t.id);
      return { text: `${t.id} ruled and moved on.` };
    }
    // integrate, answer, release: straight to merge.
    this.svc.setStatus(t.id, "review", { actor, force: true, reason: status });
    void this.p.orch.queueMerge(t.id);
    return { text: `${t.id} verified; merging into botss/integration.` };
  }

  /** ask/block/NEEDS_CONTEXT: post the question, pause the task, route it. */
  private blockWithQuestion(id: Identity, t: TaskRow | null, to: string, body: string, kind: "ask" | "batch", batch?: unknown): { message: string; question: string } {
    const a = this.actor(id);
    const run = id.kind === "agent" ? this.svc.run(id.runId) : undefined;
    const m = this.svc.message(a, to, body, kind, { task: t?.id ?? null });
    const qid = this.svc.createQuestion({ messageId: m.id, from: a.agent, to, task: t?.id ?? null, runId: run?.id ?? null, sessionId: run?.session_id ?? null, body, batch, kind });
    if (t && t.kind !== "planning" && t.status !== "done") {
      const back = ["in_progress", "ready", "changes_requested"].includes(t.status) ? t.status : "in_progress";
      this.svc.setStatus(t.id, "blocked", { force: true, actor: a.agent, reason: `asked ${to}`, extra: { blocked_on: to, blocked_reason: body.slice(0, 300) } });
      this.svc.patchMeta(t.id, { resumeStatus: back });
    }
    if (to !== "@human") this.p.orch.routeQuestion({ id: qid, messageId: m.id, to, body, from: a.agent, task: t?.id ?? null });
    return { message: m.id, question: qid };
  }

  // ------------------------------------------------------------------------------------- messaging

  private checkAddress(to: string): void {
    if (!to.startsWith("@")) throw new ServiceError(`address must start with @ (for example @frontend, @backend-2, @team, @human), got "${to}"`, 2);
    const name = to.slice(1);
    if (name === "team" || name === "human") return;
    if (isRole(name)) return;
    if (/^[a-z-]+-\d+$/.test(name) && isRole(name.replace(/-\d+$/, ""))) return;
    throw new ServiceError(`unknown address ${to}`, 2);
  }

  msg(id: Identity, to: string, body: string): CmdResult {
    this.must(id, "msg");
    this.checkAddress(to);
    if (!body.trim()) throw new ServiceError("message is empty", 2);
    checkLength(body, "the message");
    const m = this.svc.message(this.actor(id), to, body, "msg", { task: this.runTask(id) });
    return { text: `${m.id} sent to ${to}`, data: { id: m.id } };
  }

  ask(id: Identity, to: string, body: string | null, batch: unknown | null): CmdResult {
    this.must(id, "ask");
    this.checkAddress(to);
    if (to === "@team") throw new ServiceError("ask a specific role or @human, not @team", 2);
    const taskId = this.runTask(id);
    const t = taskId ? this.svc.task(taskId) : null;
    if (batch) {
      const qs = (batch as any)?.questions;
      if (!Array.isArray(qs) || qs.length === 0) throw new ServiceError("batch file must be JSON with a non-empty \"questions\" array (see product-manager references/discovery.md)", 2);
      for (const q of qs) {
        if (!q.id || !q.question) throw new ServiceError("every batch question needs \"id\" and \"question\"", 2);
      }
      const intro = String((batch as any).intro ?? `${qs.length} questions`);
      const r = this.blockWithQuestion(id, t, to, intro, "batch", batch);
      // Design-direction gate off: take the designer's recommendation without waiting.
      if (t?.kind === "planning" && t.mode === "direction" && !this.p.orch.gateEnabled("design_direction")) {
        const answers = Object.fromEntries(qs.map((q: any) => [q.id, q.recommended ?? q.options?.[0]?.key ?? ""]));
        setTimeout(() => void this.answerQuestion({ kind: "human" }, r.question, { answers, acceptedRecommendations: true }, "auto"), 0);
      }
      return { text: ASK_NOTICE, data: r };
    }
    if (!body?.trim()) throw new ServiceError("question is empty", 2);
    checkLength(body, "the question");
    const r = this.blockWithQuestion(id, t, to, body, "ask");
    return { text: `${r.message}: ${ASK_NOTICE}`, data: r };
  }

  inbox(id: Identity, all: boolean): CmdResult {
    this.must(id, "read");
    if (id.kind === "human") {
      const rows = this.svc.messages({ limit: 50 }).filter((m) => m.to_addr === "@human");
      return { text: rows.map((m) => `${m.id} ${m.from_agent}: ${m.body}`).join("\n") || "(empty)", data: rows };
    }
    const rows = this.svc.inbox(id.agent, id.role, { all, task: id.task });
    this.svc.markRead(id.agent, rows.map((r) => r.id));
    const text = rows.length ? rows.map((m) => `${m.id} ${m.created_at.slice(11, 16)} ${m.from_agent} → ${m.to_addr}${m.kind !== "msg" ? ` (${m.kind}${m.reply_to ? ` to ${m.reply_to}` : ""})` : ""}: ${m.body}`).join("\n") : "(no unread messages)";
    return { text, data: rows };
  }

  async reply(id: Identity, msgId: string, body: string): Promise<CmdResult> {
    this.must(id, "reply");
    if (!body.trim()) throw new ServiceError("reply is empty", 2);
    checkLength(body, "the reply");
    const orig = this.svc.db.get("SELECT * FROM messages WHERE id = ?", msgId);
    if (!orig) throw new ServiceError(`unknown message ${msgId}`, 2);
    const m = this.svc.message(this.actor(id), `@${orig.from_agent}`, body, "reply", { replyTo: msgId, task: orig.task });
    const q = this.svc.db.get("SELECT * FROM questions WHERE message_id = ? AND status = 'open'", msgId);
    if (q) {
      this.svc.markAnswered(q.id, body, this.actor(id).agent);
      this.svc.emit("answer.given", `${this.actor(id).agent} answered ${msgId}`, { question: q.id, message: msgId }, { actor: this.actor(id).agent, task: orig.task });
      await this.p.orch.onAnswered(q.id);
    }
    return { text: `${m.id} replied to ${msgId}`, data: { id: m.id } };
  }

  /** Owner answers from the dashboard (or auto-accept). */
  async answerQuestion(id: Identity, qid: string, answer: unknown, by = "human"): Promise<CmdResult> {
    if (id.kind !== "human") throw new ServiceError("only the owner answers from the dashboard", 3);
    const q = this.svc.question(qid);
    if (!q) throw new ServiceError(`unknown question ${qid}`, 404);
    if (q.status !== "open") throw new ServiceError(`${qid} is already answered`, 409);
    const text = typeof answer === "string" ? answer : formatBatchAnswer(q.batch, answer);
    this.svc.message({ agent: by === "auto" ? "botss" : "human", role: null }, `@${q.from_agent}`, text, "reply", { replyTo: q.message_id, task: q.task });
    this.svc.markAnswered(q.id, text, by);
    this.svc.emit("answer.given", `${by === "auto" ? "Auto-accepted recommendations for" : "Owner answered"} ${q.id}`, { question: q.id }, { actor: by, task: q.task });
    await this.p.orch.onAnswered(q.id);
    return { text: `${qid} answered` };
  }

  // ------------------------------------------------------------------------------------- decisions

  decision(id: Identity, title: string, why: string, affects: string[]): CmdResult {
    this.must(id, "decision");
    if (!title.trim()) throw new ServiceError("decision title is empty", 2);
    const a = this.actor(id);
    const d = this.svc.addDecision(title, why, affects, a.agent, a.role, this.runTask(id));
    const md = `# ${d}: ${title}\n\n- Recorded by: ${a.agent}\n- Affects: ${affects.join(", ") || "-"}\n- Date: ${new Date().toISOString().slice(0, 10)}\n\n## Why\n\n${why}\n`;
    this.svc.submitDoc(`decisions/${d}`, `.botss/docs/decisions/${d}.md`, md, a.agent, a.role, "approved");
    return { text: `${d} recorded`, data: { id: d, markdown: md, path: `.botss/docs/decisions/${d}.md` } };
  }

  decisionList(id: Identity): CmdResult {
    this.must(id, "read");
    const rows = this.svc.decisions();
    return { text: rows.map((d) => `${d.id}  ${d.title}  (affects: ${d.affects.join(", ") || "-"})`).join("\n") || "(no decisions)", data: rows };
  }

  decisionShow(id: Identity, did: string): CmdResult {
    this.must(id, "read");
    const d = this.svc.decision(did);
    if (!d) throw new ServiceError(`unknown decision ${did}`, 2);
    return { text: `${d.id}: ${d.title}\nby ${d.by_agent} on ${d.created_at.slice(0, 10)}; affects: ${d.affects.join(", ") || "-"}\n\n${d.why}`, data: d };
  }

  // ------------------------------------------------------------------------------------- documents

  docList(id: Identity): CmdResult {
    this.must(id, "read");
    const rows = this.svc.docs();
    const known = new Set(rows.map((r) => r.name));
    const lines = rows.map((d) => `${d.name.padEnd(28)} ${d.status.padEnd(18)} v${d.version}  ${d.path}`);
    for (const [n, p] of Object.entries(STANDARD_DOCS)) if (!known.has(n)) lines.push(`${n.padEnd(28)} ${"(not submitted)".padEnd(18)}     ${p}`);
    return { text: lines.join("\n"), data: rows };
  }

  docShow(id: Identity, name: string): CmdResult {
    this.must(id, "read");
    const d = this.svc.doc(name);
    if (d?.content) return { text: d.content, data: { name, status: d.status, version: d.version, path: d.path, content: d.content } };
    const rel = docPath(name);
    const f = path.join(this.p.sharedDir(), rel);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const content = fs.readFileSync(f, "utf8");
      return { text: content, data: { name, status: "draft", version: 0, path: rel, content } };
    }
    throw new ServiceError(`${name} does not exist yet (${rel})`, 2);
  }

  async docSubmit(id: Identity, name: string, content: string, file: string | null): Promise<CmdResult> {
    this.must(id, "doc.submit", { doc: name });
    if (!content.trim()) throw new ServiceError(`${file ?? docPath(name)} is empty`, 2);
    const a = this.actor(id);
    const v = this.svc.submitDoc(name, file ?? docPath(name), content, a.agent, a.role ?? docOwners(name)?.[0] ?? null);
    await this.p.orch.onDocSubmitted(name);
    return { text: `${name} v${v} submitted for approval`, data: { name, version: v } };
  }

  // -------------------------------------------------------------------------------------- planning

  async planCheck(id: Identity, files: { file: string; source: string }[]): Promise<CmdResult> {
    this.must(id, "read");
    const repoFiles = await this.projectFiles();
    const r = checkPlan(files, repoFiles);
    const stats = r.tasks.length ? planStats(r.tasks) : null;
    if (!r.ok) {
      return { exit: 1, text: `Plan has ${r.problems.length} problem(s):\n${r.problems.map((p) => `  [${p.code}] ${p.message}`).join("\n")}`, data: { ok: false, problems: r.problems } };
    }
    return {
      text: `Plan OK: ${r.tasks.length} tasks, critical path ${stats!.criticalPath.join(" -> ")}, peak ${stats!.peakLanes} parallel lanes.`,
      data: { ok: true, problems: [], stats },
    };
  }

  async planSubmit(id: Identity, files: { file: string; source: string }[], summary: string | null): Promise<CmdResult> {
    this.must(id, "plan.submit");
    const check = await this.planCheck(id, files);
    if (check.exit) return { ...check, text: `${check.text}\nNot imported. Fix the problems and run \`botss plan submit\` again.` };
    const r = checkPlan(files, await this.projectFiles());
    const a = this.actor(id);
    // During a change request the new plan waits for the owner's approval before anything new starts.
    this.svc.importPlan(r.tasks, a.agent, this.p.orch.activeChange()?.status === "replan" ? "plan" : null);
    const stats = planStats(r.tasks);
    const list = r.tasks.map((t) => `| ${t.id} | ${t.title.replace(/\|/g, "/")} | ${t.role} | ${t.size} | ${t.after.join(", ") || "-"} |`).join("\n");
    const content = `${summary?.trim() || "# Plan summary"}\n\n## Tasks (validated)\n\n| ID | Title | Role | Size | After |\n|---|---|---|---|---|\n${list}\n\nCritical path: ${stats.criticalPath.join(" → ")}. Peak parallel lanes: ${stats.peakLanes}.\n`;
    this.svc.submitDoc("plan", ".botss/docs/plan-summary.md", content, a.agent, "tech-lead");
    await this.p.orch.onDocSubmitted("plan");
    return { text: `${check.text}\nImported ${r.tasks.length} tasks. Build tasks stay todo until the owner approves the plan.`, data: { ok: true, stats } };
  }

  // ------------------------------------------------------------------------------------ review / QA

  private reviewTarget(taskId: string): TaskRow {
    const t = this.svc.mustTask(taskId);
    if (t.status !== "review") throw new ServiceError(`${t.id} is ${t.status}, not in review`, 2);
    return t;
  }

  reviewStart(id: Identity, taskId: string): CmdResult {
    this.must(id, "review");
    const t = this.reviewTarget(taskId);
    this.svc.openReview(t.id, t.review_round + 1, this.actor(id).agent);
    this.svc.emit("review.started", `${this.actor(id).agent} started reviewing ${t.id} (round ${t.review_round + 1})`, {}, { actor: this.actor(id).agent, task: t.id });
    return { text: `Reviewing ${t.id}, round ${t.review_round + 1}. Base ${t.base_sha?.slice(0, 7) ?? "?"}, head ${t.head_sha?.slice(0, 7) ?? "?"}.` };
  }

  reviewComment(id: Identity, taskId: string, c: { file?: string; line?: number; severity: string; body: string }): CmdResult {
    this.must(id, "review");
    if (!(SEVERITIES as readonly string[]).includes(c.severity)) throw new ServiceError(`--severity must be one of ${SEVERITIES.join(", ")}`, 2);
    if (!c.body.trim()) throw new ServiceError("comment text is empty", 2);
    const t = this.reviewTarget(taskId);
    this.svc.reviewComment(t.id, t.review_round + 1, this.actor(id).agent, { file: c.file ?? null, line: c.line ?? null, severity: c.severity, body: c.body });
    return { text: "comment posted" };
  }

  reviewApprove(id: Identity, taskId: string, summary: string): CmdResult {
    this.must(id, "review");
    const t = this.reviewTarget(taskId);
    const a = this.actor(id);
    this.svc.closeReview(t.id, t.review_round + 1, a.agent, "approved", summary || "approved", null, a.role ?? "reviewer");
    if (this.svc.settings.qa_per_task) this.svc.setStatus(t.id, "qa", { actor: a.agent, reason: "review approved" });
    else void this.p.orch.queueMerge(t.id);
    return { text: `${t.id} approved` };
  }

  reviewRequestChanges(id: Identity, taskId: string, summary: string, content: string | null): CmdResult {
    this.must(id, "review");
    const t = this.reviewTarget(taskId);
    const a = this.actor(id);
    const round = t.review_round + 1;
    this.svc.closeReview(t.id, round, a.agent, "changes_requested", summary || "changes requested", content, a.role ?? "reviewer");
    const rv = this.svc.reviews(t.id).filter((r) => r.round === round).at(-1);
    const comments = (rv?.comments ?? []).map((c: any) => `- [${c.severity}] ${c.file ? `${c.file}${c.line ? `:${c.line}` : ""} ` : ""}${c.body}`).join("\n");
    const prompt = `Review round ${round} requested changes on ${t.id}: ${summary}\n\n${comments}${content ? `\n\n${content}` : ""}\n\nAddress every comment (or reply with a reason), re-verify, commit, and run \`botss task done\` again.`;
    const max = this.svc.settings.max_review_rounds;
    this.svc.updateTask(t.id, { review_round: round });
    if (round >= max) {
      this.svc.patchMeta(t.id, { ruling: true, resume: null, note: `## Ruling needed\n\n${t.id} reached ${round} review rounds. Last review:\n\n${prompt}` });
      this.svc.setStatus(t.id, "changes_requested", { actor: a.agent, reason: `review cap reached (${round}); tech lead ruling` });
      this.svc.emit("review.cap", `${t.id} hit the review cap; the tech lead will rule`, { round }, { task: t.id });
    } else {
      this.svc.patchMeta(t.id, t.session_id ? { resume: { session: t.session_id, prompt } } : { note: prompt });
      this.svc.setStatus(t.id, "changes_requested", { actor: a.agent, reason: summary });
    }
    return { text: `${t.id}: changes requested (round ${round} of ${max})` };
  }

  private qaTarget(taskId: string): TaskRow {
    const t = this.svc.mustTask(taskId);
    if (t.kind === "release") {
      if (!["ready", "in_progress"].includes(t.status)) throw new ServiceError(`${t.id} is ${t.status}`, 2);
      return t;
    }
    if (t.status !== "qa") throw new ServiceError(`${t.id} is ${t.status}, not in qa`, 2);
    return t;
  }

  async qaPass(id: Identity, taskId: string, report: string): Promise<CmdResult> {
    this.must(id, "qa");
    const t = this.qaTarget(taskId);
    if (!report.trim()) throw new ServiceError("--report <file> is required", 2);
    const a = this.actor(id);
    this.svc.addQaReport(t.id, t.qa_round + 1, a.agent, "pass", report);
    if (t.kind === "release") {
      this.svc.setStatus(t.id, "review", { force: true, actor: a.agent, reason: "release QA passed" });
      void this.p.orch.onReleaseTaskFinished(t);
      return { text: `${t.id}: release QA passed` };
    }
    void this.p.orch.queueMerge(t.id);
    return { text: `${t.id}: QA passed; merging into botss/integration` };
  }

  qaFail(id: Identity, taskId: string, report: string): CmdResult {
    this.must(id, "qa");
    const t = this.qaTarget(taskId);
    if (!report.trim()) throw new ServiceError("--report <file> is required", 2);
    const a = this.actor(id);
    const round = t.qa_round + 1;
    this.svc.addQaReport(t.id, round, a.agent, "fail", report);
    if (!this.svc.bugs(t.id, "open").length) {
      const title = /^#+\s*(.+)$/m.exec(report)?.[1]?.slice(0, 120) ?? "QA failed";
      this.svc.createBug(t.id, "major", title, report, a.agent, "qa");
    }
    this.svc.updateTask(t.id, { qa_round: round });
    if (t.kind === "release") {
      this.svc.setStatus(t.id, "blocked", { force: true, actor: a.agent, reason: "release QA failed", extra: { blocked_on: "@human", blocked_reason: "release QA: no-go" } });
      this.svc.alert("Release QA failed (no-go). Review the bugs, then request changes on the release or unblock REL-QA to rerun.", t.id);
      return { text: `${t.id}: release QA failed` };
    }
    const bugs = this.svc.bugs(t.id, "open");
    const prompt = `QA round ${round} failed ${t.id}. Bugs:\n\n${bugs.map((b) => `- ${b.id} [${b.severity}] ${b.title}\n  ${String(b.content).split("\n").slice(0, 30).join("\n  ")}`).join("\n")}\n\nFix them (test first), re-verify, commit, and run \`botss task done\` again.`;
    if (round >= this.svc.settings.max_review_rounds) {
      this.svc.setStatus(t.id, "blocked", { force: true, actor: a.agent, reason: `QA failed ${round} times`, extra: { blocked_on: "@human", blocked_reason: "QA cap reached" } });
      this.svc.alert(`${t.id} failed QA ${round} times and is blocked for the owner.`, t.id);
    } else {
      this.svc.patchMeta(t.id, t.session_id ? { resume: { session: t.session_id, prompt } } : { note: prompt });
      this.svc.setStatus(t.id, "changes_requested", { actor: a.agent, reason: `QA failed (${bugs.length} bug${bugs.length === 1 ? "" : "s"})` });
    }
    return { text: `${t.id}: QA failed; ${bugs.length} bug(s) sent back to the owner` };
  }

  bugCreate(id: Identity, b: { task: string; severity: string; title: string; content: string }): CmdResult {
    this.must(id, "bug.create");
    if (!(SEVERITIES as readonly string[]).includes(b.severity)) throw new ServiceError(`--severity must be one of ${SEVERITIES.join(", ")}`, 2);
    if (!b.title.trim()) throw new ServiceError("--title is required", 2);
    this.svc.mustTask(b.task);
    const a = this.actor(id);
    const bid = this.svc.createBug(b.task, b.severity, b.title, b.content, a.agent, a.role);
    return { text: `${bid} created on ${b.task}`, data: { id: bid } };
  }
}

function formatBatchAnswer(batch: any, answer: any): string {
  const qs: any[] = batch?.questions ?? [];
  const answers: Record<string, string> = answer?.answers ?? {};
  const notes: Record<string, string> = answer?.notes ?? {};
  const lines = qs.map((q) => {
    const key = answers[q.id] ?? q.recommended ?? "";
    const opt = (q.options ?? []).find((o: any) => o.key === key);
    const label = opt ? `${key}: ${opt.label}` : key;
    return `- ${q.id} (${q.topic ?? q.question}): ${label || "(no answer)"}${notes[q.id] ? ` — note: ${notes[q.id]}` : ""}`;
  });
  if (answer?.freeText) lines.push("", `Owner notes: ${answer.freeText}`);
  return lines.join("\n") || JSON.stringify(answer);
}

export type { DoneStatus, Role };
