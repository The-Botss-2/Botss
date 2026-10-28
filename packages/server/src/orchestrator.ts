import {
  budgetTokens,
  emptyUsage,
  formatId,
  matchesAny,
  PHASE_GATE,
  quotaCheck,
  roleCap,
  schedule,
  taskBranch,
  type Gate,
  type Role,
  type RunMode,
  type SchedTask,
  type Stage,
  type StreamEvent,
  type UsageTotals,
} from "@botss/core";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitAll,
  diffNames,
  diffStat,
  ensureWorktree,
  git,
  headSha,
  INTEGRATION_BRANCH,
  removeWorktree,
} from "./git.ts";
import { cliCommand, quoteArg } from "./paths.ts";
import { snapshotDir, snapshotDiff, takeSnapshot } from "./snapshot.ts";
import { agentRuntimeEnv, allocatePortBlock } from "./ports.ts";
import type { Project } from "./project.ts";
import { buildRunPrompt, buildSystemPrompt, roleTitle } from "./prompts.ts";
import type { RunExit } from "./runner.ts";
import type { ChangeRequest, TaskRow } from "./service.ts";
import { runShell } from "./shell.ts";
import { hashToken } from "./tokens.ts";

// The deterministic orchestrator. Plain code decides scheduling, permissions, merging, and phase flow.

const PLANNING_ROLES: Role[] = ["pm", "designer", "tech-lead"];
const SCRATCH = [".botss/handoffs/**", ".botss/reviews/**", ".botss/screens/**"];

interface ActiveRun {
  runId: string;
  agent: string;
  role: Role;
  task: string | null;
  stage: Stage | "planning" | "answer";
  sessionId: string;
  usage: UsageTotals;
  result?: Extract<StreamEvent, { kind: "result" }>;
  limited?: { resetsAt?: number };
  sawInit: boolean;
  cwd: string;
  liveOutput?: number;
}

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private active = new Map<string, ActiveRun>();
  private mergeChain: Promise<unknown> = Promise.resolve();
  /** Resolves when all pending run finalizations are done (tests use it). */
  private pending = new Set<Promise<unknown>>();

  private readonly p: Project;
  constructor(p: Project) {
    this.p = p;
  }

  get svc() {
    return this.p.svc;
  }

  // ------------------------------------------------------------------------------------- lifecycle

  start(): void {
    this.recover();
    const interval = this.svc.settings.scheduler_interval_ms;
    this.timer = setInterval(() => void this.tick(), interval);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    await this.p.runner.killAll();
    await this.idle();
    while (this.ticking) await new Promise((r) => setTimeout(r, 20));
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
    await this.mergeChain;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  /** After a crash or restart: no run is active any more. Make the board consistent. */
  private recover(): void {
    for (const r of this.svc.runs({ active: true })) {
      this.svc.updateRun(r.id, { ended_at: new Date().toISOString(), result_status: "interrupted" });
      this.svc.updateAgent(r.agent, { current_run: null, status: "idle" });
      if (r.task)
        this.prepareRetry(
          r.task,
          r.session_id,
          "Botss restarted while you were working. Continue the task from where you left off (check `git status` and `botss task show $BOTSS_TASK`).",
        );
      this.svc.emit(
        "run.interrupted",
        `Run ${r.id} (${r.agent}) was interrupted by a restart`,
        {},
        { actor: r.agent, task: r.task, run: r.id },
      );
    }
    for (const a of this.svc.agents())
      if (a.current_run) this.svc.updateAgent(a.id, { current_run: null, status: "idle" });
  }

  private prepareRetry(taskId: string, session: string, prompt: string): void {
    const t = this.svc.task(taskId);
    if (!t || t.status === "done") return;
    if (t.kind === "planning" || ["ready", "in_progress", "changes_requested"].includes(t.status)) {
      this.svc.patchMeta(taskId, { resume: { session, prompt } });
    }
  }

  // ------------------------------------------------------------------------------------------ tick

  quota() {
    const st = this.svc.state;
    return quotaCheck(this.svc.settings, {
      usedToday: this.svc.usedToday(),
      limitedUntil: st.limitedUntil ?? null,
    });
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      void this.sweepWorktrees();
      const st = this.svc.state;
      if (st.limitedUntil && st.limitedUntil <= Date.now()) {
        this.svc.patchState({ limitedUntil: null });
        if (this.svc.settings.auto_resume_after_limit)
          this.svc.emit("quota.resumed", "Usage limit reset; scheduler resumed", {});
        else this.svc.patchState({ paused: true, pauseReason: "usage limit reset; resume manually" });
      }
      const settings = this.svc.settings;
      const tasks = this.svc.tasks();
      const runningByRole: Partial<Record<Role, number>> = {};
      for (const r of this.active.values()) runningByRole[r.role] = (runningByRole[r.role] ?? 0) + 1;
      const runningTasks = new Set([...this.active.values()].map((r) => r.task).filter(Boolean) as string[]);
      const buildOpen = ["build", "release_review"].includes(this.svc.phase);
      // Done tasks stay in the snapshot: promotion checks that every dependency is done.
      const snap: SchedTask[] = tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        role: t.meta.ruling ? "tech-lead" : t.role,
        status: t.status,
        after: t.after,
        owns: t.owns,
        running: runningTasks.has(t.id) || this.finalizing.has(t.id),
        occupies: this.p.direct && ["in_progress", "review", "qa", "changes_requested", "blocked"].includes(t.status),
        // Build tasks wait for plan approval; planning and answer tasks run in any phase.
        hold:
          Boolean(t.hold) ||
          ((t.kind === "build" || t.kind === "integrate") && !buildOpen) ||
          this.merging.has(t.id),
        priority: t.priority,
      }));
      const roleCaps: Partial<Record<Role, number>> = {};
      for (const role of Object.keys(this.p.roles.roles) as Role[])
        roleCaps[role] = roleCap(this.p.roles, settings, role);
      const actions = schedule({
        tasks: snap,
        runningByRole,
        roleCaps,
        globalCap: settings.max_concurrent_agents,
        quotaOk: this.quota().ok,
        paused: st.paused,
      });
      for (const a of actions) {
        if (a.type === "promote") {
          const t = this.svc.task(a.task);
          // Tasks from an unapproved replan stay in todo.
          if (t && t.status === "todo" && t.hold !== "plan" && (buildOpen || t.kind !== "build"))
            this.svc.setStatus(a.task, "ready", { reason: "dependencies done" });
        } else {
          const t = this.svc.task(a.task);
          if (!t) continue;
          if ((t.kind === "build" || t.kind === "integrate") && !buildOpen) continue;
          try {
            await this.startTaskRun(t, a.stage, a.role);
          } catch (e) {
            this.svc.alert(`Could not start ${a.task}: ${(e as Error).message}`, a.task);
            this.svc.updateTask(a.task, { hold: "error" });
          }
        }
      }
    } catch (e) {
      console.error("[botss] tick failed", e);
    } finally {
      this.ticking = false;
    }
  }

  // ---------------------------------------------------------------------------------------- agents

  private async pickAgent(role: Role): Promise<string> {
    const cap = Math.max(1, roleCap(this.p.roles, this.svc.settings, role));
    const busy = new Set([...this.active.values()].map((r) => r.agent));
    for (let n = 1; n <= cap + 8; n++) {
      const id = `${role}-${n}`;
      if (busy.has(id)) continue;
      if (!this.svc.agent(id)) {
        const taken = this.svc.agents().map((a) => a.port_block as number);
        const block = await allocatePortBlock(this.svc.settings.port_base, taken);
        this.svc.upsertAgent(id, role, block);
      }
      return id;
    }
    throw new Error(`no free ${role} agent`);
  }

  envFor(agent: string, extra: Record<string, string>): Record<string, string> {
    const a = this.svc.agent(agent)!;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !k.startsWith("BOTSS_")) env[k] = v;
    // Agents get the botss CLI on PATH through per-project shims.
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${this.p.paths.bin}${path.delimiter}${env[pathKey] ?? ""}`;
    if (process.env.BOTSS_FAKE_SCENARIO) env.BOTSS_FAKE_SCENARIO = process.env.BOTSS_FAKE_SCENARIO;
    if (process.env.BOTSS_FAKE_STATE) env.BOTSS_FAKE_STATE = process.env.BOTSS_FAKE_STATE;
    return { ...env, ...agentRuntimeEnv(agent, a.port_block as number, { test: a.role === "qa" }), ...extra };
  }

  // ------------------------------------------------------------------------------------------ runs

  /** Where a task's runs execute. Planning (and pre-build answers) use the integration worktree directly. */
  private async workspaceFor(
    t: TaskRow,
    agent: string,
  ): Promise<{ cwd: string; branch: string; shared: boolean }> {
    if (this.p.direct) {
      // Direct mode: everyone works in the project folder. Keep a copy of a build task's files on its first run
      // so reviewers (and the owner) can see what it changed.
      if (["build", "integrate", "release"].includes(t.kind)) {
        takeSnapshot(this.p.paths.root, [...t.owns, ...t.may_touch], snapshotDir(this.p.paths.botss, t.id));
      }
      return { cwd: this.p.paths.root, branch: "", shared: true };
    }
    const integ = this.p.paths.integration;
    if ((t.kind === "planning" || t.kind === "answer") && !this.buildStarted()) {
      return { cwd: integ, branch: INTEGRATION_BRANCH, shared: true };
    }
    if (t.worktree && fs.existsSync(path.join(t.worktree, ".git")))
      return { cwd: t.worktree, branch: t.branch!, shared: false };
    const branch = t.branch ?? taskBranch(t.id, t.title);
    const dir = t.worktree ?? path.join(this.p.paths.worktrees, `${agent}-${t.id}`);
    const { created } = await ensureWorktree(this.p.paths.root, dir, branch, INTEGRATION_BRANCH);
    // The base is the commit the branch actually started from. Reading the integration head separately could
    // race a merge and make the task's diff include someone else's merged files.
    const base = created ? await headSha(dir) : (t.base_sha ?? (await headSha(integ)));
    this.svc.updateTask(t.id, { worktree: dir, branch, base_sha: t.base_sha && !created ? t.base_sha : base });
    return { cwd: dir, branch, shared: false };
  }

  private modeFor(t: TaskRow, stage: Stage): RunMode {
    if (stage === "review") return "review";
    if (stage === "verify") return "verify";
    if (t.meta.ruling) return "ruling";
    if (t.mode) return t.mode as RunMode;
    if (stage === "fix") return "fix";
    return t.id === "T000" ? "scaffold" : "implement";
  }

  async startTaskRun(t: TaskRow, stage: Stage, role: Role): Promise<string> {
    const agent = await this.pickAgent(role);
    const ws = await this.workspaceFor(t, agent);
    const mode = this.modeFor(t, stage);
    const resume = (stage === "implement" || stage === "fix") && t.meta.resume ? t.meta.resume : null;
    const extra: string[] = [];
    if (t.meta.note && !resume) extra.push(t.meta.note);
    if (t.kind === "integrate" && t.meta.mergeBranch)
      extra.push(`Branch to merge: \`${t.meta.mergeBranch}\``);
    let handoff: string | null = null;
    let stat: string | null = null;
    if (stage === "review" || stage === "verify") {
      handoff = this.svc.handoffs(t.id).at(-1)?.content ?? null;
      if (this.p.direct) stat = this.taskDiff(t).stat;
      else if (t.base_sha) stat = await diffStat(ws.cwd, t.base_sha);
      if (stage === "verify") {
        const rv = this.svc.reviews(t.id).at(-1);
        if (rv?.summary) extra.push(`## Review verdict\n\n${rv.verdict}: ${rv.summary}`);
      }
    }
    const inbox = this.svc.inbox(agent, role).slice(-20);
    const prompt = resume
      ? resume.prompt
      : buildRunPrompt({ mode, stage, task: t, inbox, extra, handoff, diffStat: stat, agent, roleTitle: roleTitle(this.p.roles, role) });
    const writable = this.writableFor(t, role, stage);
    const runId = await this.launch({
      agent,
      role,
      task: t,
      stage: t.kind === "planning" ? "planning" : t.kind === "answer" ? "answer" : stage,
      mode,
      cwd: ws.cwd,
      branch: ws.branch,
      prompt,
      resumeSession: resume?.session ?? null,
      writable,
      allowMerge: t.kind === "integrate",
      allowNetwork: Boolean(t.meta.allowNetwork),
    });
    if (resume) this.svc.patchMeta(t.id, { resume: null });
    if (stage === "implement" || stage === "fix") this.svc.updateTask(t.id, { assignee: agent });
    return runId;
  }

  writableFor(t: TaskRow, role: Role, stage: Stage): string[] {
    const roleWrites = this.p.roles.roles[role]?.writes ?? [];
    if (stage === "review") return [".botss/reviews/**"];
    if (stage === "verify") return [...roleWrites, ...SCRATCH];
    if (t.kind === "planning" || t.kind === "answer") return [...roleWrites, ...SCRATCH];
    return [...t.owns, ...t.may_touch, ...roleWrites, ...SCRATCH];
  }

  private async launch(o: {
    agent: string;
    role: Role;
    task: TaskRow;
    stage: ActiveRun["stage"];
    mode: string;
    cwd: string;
    branch: string;
    prompt: string;
    resumeSession: string | null;
    writable: string[];
    allowMerge: boolean;
    allowNetwork: boolean;
  }): Promise<string> {
    const settings = this.svc.settings;
    const runId = formatId("R", this.svc.db.next("R"), 5);
    const dir = this.p.paths.run(runId);
    fs.mkdirSync(dir, { recursive: true });
    const sessionId = o.resumeSession ?? crypto.randomUUID();
    const skills = this.p.roles.roles[o.role]?.skills ?? ["team-protocol"];
    const systemFile = path.join(dir, "system.md");
    fs.writeFileSync(
      systemFile,
      buildSystemPrompt({ roleTitle: roleTitle(this.p.roles, o.role), project: this.p.paths.name, skills, skillsDir: this.p.skillsDir(), direct: this.p.direct }),
    );
    fs.writeFileSync(path.join(dir, "prompt.md"), o.prompt);
    const a = this.svc.agent(o.agent)!;
    const guardFile = path.join(dir, "guard.json");
    fs.writeFileSync(
      guardFile,
      JSON.stringify(
        {
          projectId: this.p.id,
          runId,
          role: o.role,
          agent: o.agent,
          task: o.task.id,
          worktree: o.cwd,
          writable: o.writable,
          branch: o.branch,
          composeProject: a.compose_project,
          homeDir: os.homedir(),
          allowNetwork: o.allowNetwork,
          allowMerge: o.allowMerge,
          direct: this.p.direct,
        },
        null,
        2,
      ),
    );
    // Forward slashes work for both Git Bash (how Claude Code runs hooks on Windows) and POSIX shells.
    const hookCmd =
      cliCommand()
        .map((a) => quoteArg(a.replace(/\\/g, "/")))
        .join(" ") + " hook pre-tool-use";
    const settingsFile = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob",
                hooks: [{ type: "command", command: hookCmd, timeout: 30 }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const identity = {
      kind: "agent" as const,
      agent: o.agent,
      role: o.role,
      task: o.task.kind === "planning" ? null : o.task.id,
      runId,
    };
    const token = this.p.tokens.issue(this.p.id, identity);
    this.svc.insertRun({
      id: runId,
      agent: o.agent,
      role: o.role,
      task: o.task.id,
      stage: o.stage,
      session_id: sessionId,
      mode: o.resumeSession ? "resume" : "fresh",
      cwd: o.cwd,
      token_hash: hashToken(token),
    });
    this.svc.updateRun(runId, { mode: o.resumeSession ? "resume" : "fresh" });
    const env = this.envFor(o.agent, {
      BOTSS_AGENT: o.agent,
      BOTSS_ROLE: o.role,
      BOTSS_TASK: o.task.kind === "planning" ? "" : o.task.id,
      BOTSS_MODE: o.mode,
      BOTSS_ROOT: this.p.paths.root,
      BOTSS_WORKTREE: o.cwd,
      BOTSS_SERVER_URL: this.p.serverUrl(),
      BOTSS_TOKEN: token,
      BOTSS_PROJECT: this.p.id,
      BOTSS_RUN: runId,
      BOTSS_GUARD_FILE: guardFile,
    });
    const run: ActiveRun = {
      runId,
      agent: o.agent,
      role: o.role,
      task: o.task.id,
      stage: o.stage,
      sessionId,
      usage: emptyUsage(),
      sawInit: false,
      cwd: o.cwd,
    };
    this.active.set(runId, run);
    this.svc.updateAgent(o.agent, {
      current_task: o.task.id,
      current_run: runId,
      status: "working",
      last_action: "Starting",
      last_file: null,
    });
    if (
      o.task.kind !== "planning" &&
      o.task.kind !== "answer" &&
      !o.task.session_id &&
      (o.stage === "implement" || o.stage === "fix")
    ) {
      this.svc.updateTask(o.task.id, { session_id: sessionId });
    }
    const maxTurns = settings.max_turns[o.role] ?? settings.default_max_turns;
    const { pid } = this.p.runner.start(
      {
        runId,
        cwd: o.cwd,
        env,
        sessionId,
        resume: Boolean(o.resumeSession),
        prompt: o.prompt,
        systemFile,
        settingsFile,
        streamFile: path.join(dir, "stream.jsonl"),
        maxTurns,
        model: settings.models[o.role],
        permissionMode: settings.permission_mode,
        allowedTools: settings.allowed_tools,
        disallowedTools: settings.disallowed_tools,
        timeoutMs: settings.run_timeout_minutes * 60_000,
      },
      {
        onEvent: (ev) => this.onStream(run, ev),
        onExit: (exit) => {
          void this.track(this.onExit(run, exit));
        },
      },
    );
    this.svc.updateRun(runId, { pid: pid ?? null });
    this.svc.emit(
      "run.started",
      `${o.agent} started ${o.task.kind === "planning" ? `${o.mode}` : `${o.stage} on ${o.task.id}`}${o.resumeSession ? " (resumed)" : ""}`,
      { stage: o.stage, mode: o.mode, resume: Boolean(o.resumeSession), session: sessionId },
      { actor: o.agent, role: o.role, task: o.task.id, run: runId },
    );
    return runId;
  }

  /** Set once the project database is closed: late stream lines and exits are dropped. */
  closed = false;

  private onStream(run: ActiveRun, ev: StreamEvent): void {
    if (this.closed) return;
    const meta = { actor: run.agent, role: run.role, task: run.task, run: run.runId };
    switch (ev.kind) {
      case "init":
        run.sawInit = true;
        this.svc.updateRun(run.runId, { session_id: ev.sessionId || run.sessionId });
        if (ev.sessionId) run.sessionId = ev.sessionId;
        this.svc.emit(
          "run.init",
          `${run.agent} session ${ev.sessionId.slice(0, 8)} (${ev.model ?? "default model"})`,
          { model: ev.model },
          meta,
        );
        break;
      case "tool":
        if (ev.file && path.isAbsolute(ev.file)) {
          const rel = path.relative(run.cwd, ev.file);
          if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
            const r = rel.replace(/\\/g, "/");
            ev = { ...ev, file: r, summary: ev.summary.replace(ev.file, r) };
          }
        }
        // Plain-language status for the dashboard ("Running the tests"), with the technical summary in the feed.
        this.svc.updateAgent(run.agent, { last_action: ev.label, last_file: ev.file ?? null, activity: ev.activity });
        this.svc.updateRun(run.runId, { last_action: ev.label, last_file: ev.file ?? null, activity: ev.activity });
        this.svc.emit(
          "run.tool",
          ev.summary,
          { tool: ev.tool, file: ev.file ?? null, input: ev.input, toolUseId: ev.toolUseId ?? null, activity: ev.activity, label: ev.label },
          meta,
        );
        if (ev.tool === "TodoWrite") this.svc.updateRun(run.runId, { todos: JSON.stringify(ev.input.todos ?? []) });
        break;
      case "text": {
        const one = ev.text.replace(/\s+/g, " ");
        this.svc.emit("run.text", one.length > 200 ? `${one.slice(0, 199)}…` : one, { text: ev.text }, meta);
        break;
      }
      case "tool_result": {
        const first = ev.text.split("\n").find((l) => l.trim()) ?? "";
        this.svc.emit(
          "run.result",
          `${ev.isError ? "✗ " : ""}${first.slice(0, 160) || (ev.isError ? "error" : "ok")}`,
          { toolUseId: ev.toolUseId ?? null, isError: ev.isError, text: ev.text },
          meta,
        );
        if (ev.isError && /Botss guard/.test(ev.text)) this.svc.emit("run.blocked", ev.text.slice(0, 400), {}, meta);
        break;
      }
      case "usage":
        // Live estimate while the run works (output summed, input as of the latest call); the final result
        // event replaces it with Claude Code's own totals.
        run.liveOutput = (run.liveOutput ?? 0) + ev.usage.output_tokens;
        this.svc.updateRun(run.runId, {
          input_tokens: ev.usage.input_tokens,
          output_tokens: run.liveOutput,
          cache_creation_tokens: ev.usage.cache_creation_input_tokens,
          cache_read_tokens: ev.usage.cache_read_input_tokens,
        });
        break;
      case "retry":
        this.svc.emit("run.retry", `API retry (${ev.error})`, { error: ev.error }, meta);
        break;
      case "rate_limit":
        if (ev.status === "rejected") run.limited = { resetsAt: ev.resetsAt };
        break;
      case "result":
        run.result = ev;
        run.usage = ev.usage;
        if (ev.usageLimit) run.limited = ev.usageLimit;
        break;
    }
  }

  /** Tasks whose last run is being finalized: they count as running so the scheduler cannot start them twice. */
  private finalizing = new Set<string>();

  private async onExit(run: ActiveRun, exit: RunExit): Promise<void> {
    if (this.closed) return;
    if (run.task) this.finalizing.add(run.task);
    try {
      await this.finalizeRun(run, exit);
    } finally {
      if (run.task) this.finalizing.delete(run.task);
    }
    void this.tick();
  }

  private async finalizeRun(run: ActiveRun, exit: RunExit): Promise<void> {
    this.active.delete(run.runId);
    this.p.tokens.revokeRun(run.runId);
    const r = run.result;
    const status = exit.killed
      ? "killed"
      : exit.timedOut
        ? "timeout"
        : run.limited
          ? "limited"
          : r && !r.isError && exit.code === 0
            ? "success"
            : "error";
    this.svc.updateRun(run.runId, {
      ended_at: new Date().toISOString(),
      exit_code: exit.code,
      turns: r?.turns ?? 0,
      input_tokens: run.usage.input_tokens,
      output_tokens: run.usage.output_tokens,
      cache_creation_tokens: run.usage.cache_creation_input_tokens,
      cache_read_tokens: run.usage.cache_read_input_tokens,
      cost_usd: r?.costUsd ?? 0,
      result_status: status,
      result_text: (r?.text || exit.stderr.slice(-400)) ?? null,
    });
    const cur = this.svc.agent(run.agent);
    if (cur?.current_run === run.runId)
      this.svc.updateAgent(run.agent, {
        current_run: null,
        current_task: null,
        status: "idle",
        last_action: `Finished (${status})`,
      });
    const meta = { actor: run.agent, role: run.role, task: run.task, run: run.runId };
    this.svc.emit(
      "run.ended",
      `${run.agent} finished ${run.stage}${run.task ? ` on ${run.task}` : ""}: ${status}${r ? ` · ${r.turns} turns · ${budgetTokens(run.usage).toLocaleString()} tokens` : ""}`,
      {
        status,
        exit: exit.code,
        turns: r?.turns ?? 0,
        tokens: budgetTokens(run.usage),
        cost: r?.costUsd ?? 0,
      },
      meta,
    );
    if (status === "killed") return;
    if (status === "limited") {
      const until = run.limited?.resetsAt ?? Date.now() + 60 * 60_000;
      this.svc.patchState({ limitedUntil: until });
      this.svc.emit(
        "quota.limit",
        `Claude Code usage limit reached; Botss paused until ${new Date(until).toLocaleTimeString()}`,
        { resetsAt: until },
        meta,
      );
      this.svc.alert(
        `Usage limit reached. Botss pauses until ${new Date(until).toLocaleString()}${this.svc.settings.auto_resume_after_limit ? " and then resumes automatically" : ""}.`,
      );
      if (run.task)
        this.prepareRetry(
          run.task,
          run.sessionId,
          "You were paused by a usage limit. Continue the task from where you left off.",
        );
      return;
    }
    if (!run.task) return;
    const t = this.svc.task(run.task);
    if (!t) return;
    const ok = status === "success";
    try {
      if (t.kind === "planning") await this.afterPlanningRun(t, run, ok);
      else if (t.kind === "answer") await this.afterAnswerRun(t, run, ok);
      else await this.afterTaskRun(t, run, ok, status);
    } catch (e) {
      this.svc.alert(`Post-run handling failed for ${t.id}: ${(e as Error).message}`, t.id);
    }
  }

  private failRun(t: TaskRow, run: ActiveRun, why: string, resumePrompt: string | null): void {
    const fails = t.run_failures + 1;
    const max = this.svc.settings.max_verify_failures;
    this.svc.updateTask(t.id, { run_failures: fails });
    this.svc.emit(
      "task.run_failed",
      `${t.id}: ${why} (attempt ${fails} of ${max})`,
      { why, attempt: fails },
      { actor: run.agent, task: t.id },
    );
    if (fails >= max) {
      this.svc.setStatus(t.id, "blocked", {
        force: true,
        reason: `${fails} runs ended without finishing: ${why}`,
        extra: { blocked_on: "@human", blocked_reason: why },
      });
      this.svc.alert(
        `${t.id} is blocked after ${fails} failed runs: ${why}. Check the agent log, then unblock or adjust the task.`,
        t.id,
      );
    } else if (resumePrompt && run.sawInit) {
      this.svc.patchMeta(t.id, { resume: { session: run.sessionId, prompt: resumePrompt } });
    }
  }

  private async afterTaskRun(t: TaskRow, run: ActiveRun, ok: boolean, status: string): Promise<void> {
    if (run.stage === "implement" || run.stage === "fix") {
      if (["review", "qa", "blocked", "done"].includes(t.status)) {
        if (t.run_failures) this.svc.updateTask(t.id, { run_failures: 0 });
        return;
      }
      this.failRun(
        t,
        run,
        ok ? "run ended without `botss task done` or `botss task block`" : `run ${status}`,
        "Your previous run ended before the task was finished: `botss task done` was not called, or it was refused. Check `botss task show $BOTSS_TASK` and `git status`, finish the work, and hand off with `botss task done`.",
      );
    } else if (run.stage === "review") {
      if (t.status === "review" && !this.merging.has(t.id))
        this.failRun(t, run, "review ended without a verdict", null);
    } else if (run.stage === "verify") {
      if (t.status === "qa" && !this.merging.has(t.id))
        this.failRun(t, run, "QA ended without pass or fail", null);
    }
  }

  // ------------------------------------------------------------------------------------- planning

  createPlanningTask(
    role: Role,
    mode: RunMode,
    opts: { body?: string; resume?: { session: string; prompt: string } | null; note?: string; changeId?: string } = {},
  ): TaskRow {
    const id = this.svc.nextId("P");
    return this.svc.createTask({
      id,
      kind: "planning",
      mode,
      title: `${roleTitle(this.p.roles, role)}: ${mode}${opts.changeId ? ` (${opts.changeId})` : ""}`,
      role,
      status: "ready",
      priority: 0,
      body: opts.body ?? "",
      meta: { resume: opts.resume ?? null, note: opts.note ?? null, changeId: opts.changeId },
    });
  }

  /** Planning and answer work shares the integration worktree only before the build; afterwards it gets its
   * own worktree and is merged like a task, so it never races the merge pipeline. */
  private buildStarted(): boolean {
    return ["build", "release_review", "done"].includes(this.svc.phase) || this.svc.tasks({ kind: ["build"] }).some((t) => t.status !== "todo");
  }

  /** Direct mode: what a task changed since its first run (files and a unified diff). */
  taskDiff(t: TaskRow): { files: { path: string; status: string }[]; diff: string; stat: string } {
    return snapshotDiff(this.p.paths.root, [...t.owns, ...t.may_touch], snapshotDir(this.p.paths.botss, t.id));
  }

  private async commitIntegration(message: string): Promise<void> {
    if (this.p.direct) return;
    const integ = this.p.paths.integration;
    // Never pick up merge leftovers: only planning output paths.
    await commitAll(integ, message, ["-A", "--", ".botss/docs", ".botss/tasks"]).catch(() => false);
  }

  private planningOutcome(t: TaskRow, sinceRun: string): boolean {
    const run = this.svc.run(sinceRun);
    const since = run?.started_at ?? t.created_at;
    const asked = this.svc.questions().some((q) => q.task === t.id && q.kind === "batch");
    const docSince = (name: string) => {
      const d = this.svc.doc(name);
      return Boolean(d && d.versions.some((v: any) => v.created_at >= since));
    };
    switch (t.mode) {
      case "discover":
      case "direction":
        return asked;
      case "draft":
      case "revise":
      case "change":
        return docSince("prd");
      case "architect":
        return docSince("architecture");
      case "plan":
      case "replan":
        return docSince("plan");
      case "screens":
        return docSince("design");
      case "survey":
        return docSince("codebase");
      case "triage":
        return docSince("triage");
      default:
        return true;
    }
  }

  private async afterPlanningRun(t: TaskRow, run: ActiveRun, ok: boolean): Promise<void> {
    const msg = `botss: ${t.mode} (${run.agent})`;
    if (t.worktree) await commitAll(t.worktree, msg, ["-A", "--", ".botss/docs", ".botss/tasks"]).catch(() => false);
    else await this.commitIntegration(msg);
    if (ok && this.planningOutcome(t, run.runId)) {
      this.svc.updateTask(t.id, { session_id: run.sessionId });
      if (t.worktree) {
        this.svc.setStatus(t.id, "review", { force: true, reason: `${t.mode} complete; merging` });
        await this.queueMerge(t.id); // onPlanningDone runs after the merge
        return;
      }
      this.svc.setStatus(t.id, "done", { force: true, reason: `${t.mode} complete` });
      await this.onPlanningDone(this.svc.task(t.id)!, run.sessionId);
      return;
    }
    const expected: Record<string, string> = {
      discover: "post a question batch with `botss ask @human --batch`",
      direction: "post the directions with `botss ask @human --batch`",
      draft: "submit the PRD with `botss doc submit prd`",
      revise: "resubmit the PRD with `botss doc submit prd`",
      change: "update and resubmit the PRD with `botss doc submit prd`",
      architect: "submit the architecture with `botss doc submit architecture`",
      plan: "submit a valid plan with `botss plan submit .botss/tasks/`",
      replan: "submit the updated plan with `botss plan submit .botss/tasks/`",
      screens: "submit the design with `botss doc submit design`",
      survey: "submit the codebase summary with `botss doc submit codebase`",
      triage: "write `.botss/docs/triage.md` (first line `track: quick|standard|full`) and `botss doc submit triage`",
    };
    this.failRun(
      t,
      run,
      ok ? `run ended without the expected output (${expected[t.mode ?? ""] ?? "?"})` : "run failed",
      `Your run ended before you finished. You still need to ${expected[t.mode ?? ""] ?? "finish your mode"}.`,
    );
  }

  private async onPlanningDone(t: TaskRow, session: string): Promise<void> {
    switch (t.mode) {
      case "triage":
        await this.afterTriage();
        break;
      case "survey":
        this.captureChecksFrom(this.svc.doc("codebase")?.content ?? "", "codebase summary");
        this.createPlanningTask("pm", "discover");
        break;
      case "system":
        this.createPlanningTask("designer", "screens", {
          resume: { session, prompt: buildRunPrompt({ mode: "screens", stage: "implement", task: null, inbox: [] }) },
        });
        break;
      case "replan": {
        // Approved while the replan was still merging: release the new tasks now.
        const ch = this.changes().find((c) => c.id === t.meta.changeId);
        if (ch?.status === "applied") this.releasePlanHolds();
        break;
      }
      default:
        // screens → waits for the design gate; change → waits for the PRD gate.
        break;
    }
  }

  private releasePlanHolds(): void {
    for (const t of this.svc.tasks({ kind: ["build"] })) if (t.hold === "plan") this.svc.updateTask(t.id, { hold: null });
    void this.tick();
  }

  // ------------------------------------------------------------------------------------ idea + gates

  async submitIdea(input: {
    text: string;
    stakes?: string;
    links?: string[];
    attachments?: { name: string; data: string }[];
    kind?: "new" | "feature" | "fix";
    /** auto: the tech lead sizes the request (triage); otherwise the owner's choice. */
    track?: "auto" | "quick" | "standard" | "full";
  }): Promise<void> {
    // A new request is welcome when nothing else is in flight: at the start, or after the last one finished.
    if (!["idea", "done"].includes(this.svc.phase))
      throw new Error(`the team is still working on the current request (phase: ${this.svc.phase}). Wait for it to finish, request a change, or cancel the current work first.`);
    const existing = this.svc.settings.existing;
    const kind = input.kind ?? (existing ? "feature" : "new");
    const integ = this.p.sharedDir();
    const docs = path.join(integ, ".botss/docs");
    fs.mkdirSync(path.join(docs, "attachments"), { recursive: true });
    const names = this.saveAttachments(path.join(docs, "attachments"), input.attachments ?? []);
    const md = [
      existing ? `# Request (${kind === "fix" ? "fix" : "feature"} in an existing codebase)` : "# Idea",
      "",
      input.text.trim(),
      "",
      input.stakes ? `**Stakes:** ${input.stakes}\n` : "",
      existing ? "**Existing codebase:** change only what this request asks; the tech lead's survey is in `.botss/docs/codebase.md`.\n" : "",
      input.links?.length ? `## Links\n\n${input.links.map((l) => `- ${l}`).join("\n")}\n` : "",
      names.length ? `## Attachments\n\n${names.map((n) => `- .botss/docs/attachments/${n}`).join("\n")}\n` : "",
    ].join("\n");
    fs.writeFileSync(path.join(docs, "idea.md"), md);
    if (!this.p.direct) await commitAll(integ, "botss: owner idea", ["-A", "--", ".botss/docs"]);
    this.svc.patchState({ idea: { text: input.text, stakes: input.stakes, links: input.links ?? [], attachments: names, kind } });
    this.svc.submitDoc("idea", ".botss/docs/idea.md", md, "human", null, "approved");
    this.svc.emit("idea.submitted", existing ? `Owner asked for a ${kind} in the existing codebase` : "Owner submitted the idea", { attachments: names.length, kind }, { actor: "human" });
    this.svc.setPhase("discovery");
    const track = input.track ?? "auto";
    this.svc.patchState({ track: track === "auto" ? null : track });
    if (track === "full") this.startFullTrack();
    else {
      // Size the work first, like a lead would: a UI tweak should not go through discovery, PRD, and design.
      this.createPlanningTask("tech-lead", "triage", {
        note: track === "auto" ? undefined : `The owner chose the **${track}** track. Set the request up that way.`,
      });
    }
    void this.tick();
  }

  private startFullTrack(): void {
    // Existing codebase: the tech lead reads it first, so the PM and the plan build on what is there.
    if (this.svc.settings.existing && !this.svc.doc("codebase")) this.createPlanningTask("tech-lead", "survey");
    else this.createPlanningTask("pm", "discover");
  }

  /** The tech lead's triage decided how much process this request needs. */
  private async afterTriage(): Promise<void> {
    const text = this.svc.doc("triage")?.content ?? "";
    const m = /track\s*[:=]\s*\**\s*(quick|standard|full)/i.exec(text);
    const forced = this.svc.state.track;
    let track = (forced ?? m?.[1]?.toLowerCase() ?? "standard") as "quick" | "standard" | "full";
    const newTasks = this.svc.tasks({ kind: ["build"] }).filter((x) => x.status === "todo" || x.status === "ready");
    if (track === "quick" && newTasks.length === 0) track = "standard"; // no tasks were planned: needs a spec after all
    this.svc.patchState({ track });
    this.svc.emit("project.track", `Process: ${track} (${track === "quick" ? "build it right away" : track === "standard" ? "short PRD, then a plan" : "full discovery, design, and architecture"})`, { track }, { actor: "tech-lead-1", role: "tech-lead" });
    if (track === "quick") {
      // Small, clear work: no gates, no review or QA rounds. The task's verify command still has to pass.
      for (const x of newTasks) this.svc.patchMeta(x.id, { fast: true });
      for (const x of newTasks) if (x.hold === "plan") this.svc.updateTask(x.id, { hold: null });
      if (this.svc.doc("plan")?.status === "submitted") this.svc.setDocStatus("plan", "approved", "quick track", "auto");
      this.svc.setPhase("build");
    } else if (track === "standard") {
      this.createPlanningTask("pm", "draft", {
        note: "**Standard track:** write a short PRD (about one page) straight from the request. Ask the owner only if something genuinely blocks you. The team skips visual directions and a separate architecture document.",
      });
    } else {
      this.startFullTrack();
    }
  }

  /** Owner's "cancel current work": stop agents and close everything in flight, keeping finished work. */
  async cancelCurrentWork(): Promise<void> {
    await this.killAll();
    for (const t of this.svc.tasks()) {
      if (t.status === "done") continue;
      this.svc.setStatus(t.id, "done", { force: true, reason: "cancelled by the owner", extra: { hold: "cancelled" } });
    }
    for (const q of this.svc.questions("open")) this.svc.markAnswered(q.id, "(cancelled by the owner)", "human");
    const ch = this.activeChange();
    if (ch) this.setChange(ch.id, "cancelled");
    this.svc.patchState({ paused: false, pauseReason: null, track: null });
    this.svc.setPhase("idea");
    this.svc.emit("project.cancelled", "Owner cancelled the current work. Finished work is kept; send a new request when you are ready.", {}, { actor: "human" });
  }

  private saveAttachments(dir: string, list: { name: string; data: string }[]): string[] {
    fs.mkdirSync(dir, { recursive: true });
    const names: string[] = [];
    for (const a of list) {
      const safe = path.basename(a.name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "attachment";
      fs.writeFileSync(path.join(dir, safe), Buffer.from(a.data, "base64"));
      names.push(safe);
    }
    return names;
  }

  gateEnabled(gate: Gate): boolean {
    return this.svc.settings.gates[gate] !== false;
  }

  /** Called by the service commands when an agent submits a document. */
  async onDocSubmitted(name: string): Promise<void> {
    const phase = this.svc.phase;
    const ch = this.activeChange();
    if (name === "prd" && ch?.status === "pm") {
      this.setChange(ch.id, "prd_review");
      if (!this.gateEnabled("prd")) await this.approve("prd", "auto-approved (gate off)", "auto");
    } else if (name === "plan" && ch?.status === "replan") {
      this.setChange(ch.id, "plan_review");
      if (!this.gateEnabled("plan")) await this.approve("plan", "auto-approved (gate off)", "auto");
    } else if (name === "prd" && ["discovery", "prd_review", "idea"].includes(phase)) {
      this.svc.setPhase("prd_review");
      if (!this.gateEnabled("prd")) await this.approve("prd", "auto-approved (gate off)", "auto");
    } else if (name === "design" && phase === "design") {
      if (!this.gateEnabled("design")) await this.approve("design", "auto-approved (gate off)", "auto");
    } else if (name === "architecture" && phase === "architecture_review") {
      if (!this.gateEnabled("architecture")) await this.approve("architecture", "auto-approved (gate off)", "auto");
    } else if (name === "plan" && phase === "plan_review") {
      if (!this.gateEnabled("plan")) await this.approve("plan", "auto-approved (gate off)", "auto");
    }
  }

  /** The gate is open through the phase flow, or through an active change request. */
  private gateVia(gate: Gate): "phase" | "change" {
    const ch = this.activeChange();
    if (ch && ((gate === "prd" && ch.status === "prd_review") || (gate === "plan" && ch.status === "plan_review"))) return "change";
    const phase = this.svc.phase;
    const expect = Object.entries(PHASE_GATE).find(([, g]) => g === gate)?.[0];
    if (expect !== phase) throw new Error(`gate ${gate} is not open (phase is ${phase})`);
    return "phase";
  }

  async approve(gate: Gate, comment: string | null, actor = "human", team?: Record<string, number>): Promise<void> {
    const via = this.gateVia(gate);
    const doc = gate === "design_direction" ? null : gate;
    const d = doc ? this.svc.doc(doc) : null;
    if (doc && !d) throw new Error(`nothing submitted for ${gate} yet`);
    if (doc) this.svc.setDocStatus(doc, "approved", comment, actor);
    this.svc.recordApproval(gate, doc, d?.version ?? null, "approved", comment);
    if (via === "change") {
      const ch = this.activeChange()!;
      if (gate === "prd") {
        if (this.svc.tasks({ kind: ["build"] }).length === 0) {
          // No plan yet: the later planning steps read the updated PRD.
          this.setChange(ch.id, "applied");
        } else {
          this.setChange(ch.id, "replan");
          this.createPlanningTask("tech-lead", "replan", { body: this.changeBody(ch), changeId: ch.id });
        }
      } else {
        if (team) this.svc.updateSettings({ team }, actor);
        // New tasks start only once the replan's task files are merged into botss/integration; if that merge
        // is still running, onPlanningDone releases them.
        const replanPending = this.svc.tasks({ kind: ["planning"] }).some((t) => t.meta.changeId === ch.id && t.mode === "replan" && t.status !== "done");
        if (!replanPending) this.releasePlanHolds();
        this.setChange(ch.id, "applied");
        if (["release_review", "done"].includes(this.svc.phase)) this.reopenBuild();
        this.svc.emit("plan.approved", `Updated plan approved (${ch.id})`, { change: ch.id }, { actor });
      }
      void this.tick();
      return;
    }
    switch (gate) {
      case "prd":
        if (this.svc.state.track === "standard") {
          // Standard track: no visual directions or architecture document; straight to the plan.
          this.svc.setPhase("plan_review");
          this.createPlanningTask("tech-lead", "plan", {
            note: "**Standard track:** there is no separate architecture document. Plan the approved PRD directly, keep it small, and put any decisions in `.botss/docs/plan-summary.md`.",
          });
        } else {
          this.svc.setPhase("design_direction");
          this.createPlanningTask("designer", "direction");
        }
        break;
      case "design":
        this.svc.setPhase("architecture_review");
        this.createPlanningTask("tech-lead", "architect");
        break;
      case "architecture":
        this.svc.setPhase("plan_review");
        this.createPlanningTask("tech-lead", "plan");
        break;
      case "plan":
        if (team) this.svc.updateSettings({ team }, actor);
        for (const t of this.svc.tasks({ kind: ["build"] })) if (t.hold === "plan") this.svc.updateTask(t.id, { hold: null });
        this.svc.setPhase("build");
        this.svc.emit("plan.approved", "Plan approved: build starts", { team: team ?? null }, { actor });
        break;
      case "release":
        this.svc.setPhase("done");
        this.svc.emit("project.done", "Release approved. Merge botss/integration into your main branch when you are ready.", {}, { actor });
        break;
      case "design_direction":
        break;
    }
    void this.tick();
  }

  async requestChanges(gate: Gate, comment: string, actor = "human"): Promise<void> {
    const via = this.gateVia(gate);
    const doc = gate === "design_direction" ? null : gate;
    const d = doc ? this.svc.doc(doc) : null;
    if (doc && d) this.svc.setDocStatus(doc, "changes_requested", comment, actor);
    this.svc.recordApproval(gate, doc, d?.version ?? null, "changes_requested", comment);
    const comments = d
      ? (d.versions.at(-1)?.comments ?? []).map((c: any) => `- ${c.anchor ? `(${c.anchor}) ` : ""}${c.body}`).join("\n")
      : `- ${comment}`;
    const note = `## Owner's comments\n\n${comments || `- ${comment}`}`;
    if (via === "change") {
      const ch = this.activeChange()!;
      if (gate === "prd") {
        this.setChange(ch.id, "pm");
        this.createPlanningTask("pm", "change", { body: this.changeBody(ch), note: `The owner asked for changes to your PRD update.\n\n${note}`, changeId: ch.id });
      } else {
        this.setChange(ch.id, "replan");
        this.createPlanningTask("tech-lead", "replan", { body: this.changeBody(ch), note: `The owner asked for changes to the updated plan.\n\n${note}`, changeId: ch.id });
      }
      void this.tick();
      return;
    }
    switch (gate) {
      case "prd":
        this.createPlanningTask("pm", "revise", { note });
        break;
      case "design":
        this.createPlanningTask("designer", "screens", { note: `The owner reviewed the screens and asked for changes. Update the affected specs and mockups, then resubmit.\n\n${note}` });
        break;
      case "architecture":
        this.createPlanningTask("tech-lead", "architect", { note: `The owner requested changes to the architecture.\n\n${note}` });
        break;
      case "plan":
        this.createPlanningTask("tech-lead", "plan", { note: `The owner requested changes to the plan.\n\n${note}` });
        break;
      case "release": {
        this.svc.setPhase("build");
        const id = this.svc.nextId("I");
        this.svc.createTask({
          id,
          kind: "integrate",
          mode: "integrate",
          title: "Release follow-up from the owner",
          role: "tech-lead",
          status: "ready",
          priority: 0,
          owns: [],
          body: `The owner did not approve the release.\n\n${note}\n\nTriage: fix what is mechanical within this task, and create tasks for the owning roles for the rest (message the tech lead team).`,
          verify: this.svc.settings.checks.join(" && ") || "true",
        });
        break;
      }
      case "design_direction":
        break;
    }
    void this.tick();
  }

  // ------------------------------------------------------------------------------- change requests

  changes(): ChangeRequest[] {
    return this.svc.state.changes ?? [];
  }

  activeChange(): ChangeRequest | null {
    return this.changes().find((c) => ["pm", "prd_review", "replan", "plan_review"].includes(c.status)) ?? null;
  }

  private setChange(id: string, status: ChangeRequest["status"]): void {
    const list = this.changes().map((c) => (c.id === id ? { ...c, status, updated_at: new Date().toISOString() } : c));
    this.svc.patchState({ changes: list });
    this.svc.emit("change.status", `${id}: ${status.replace("_", " ")}`, { id, status }, { actor: "orchestrator" });
  }

  private changeBody(ch: ChangeRequest): string {
    return [
      `## Change request ${ch.id} from the owner`,
      "",
      ch.text,
      "",
      ch.attachments.length ? `Attachments (read them): ${ch.attachments.map((a) => `\`${a}\``).join(", ")}\n` : "",
      "Change only what this request asks. Work that is already merged stays as it is unless the request says otherwise.",
    ].join("\n");
  }

  /** The owner asks for a change at any point after the PRD was first approved. */
  async requestChange(text: string, attachments: { name: string; data: string }[] = []): Promise<ChangeRequest> {
    const prdApproved = this.svc.db.get("SELECT id FROM approvals WHERE gate = 'prd' AND decision = 'approved' LIMIT 1");
    if (!prdApproved) throw new Error("changes can be requested once the PRD has been approved; before that, comment on the PRD instead");
    const active = this.activeChange();
    if (active) throw new Error(`${active.id} is still in progress (${active.status}); finish or cancel it first`);
    if (!text.trim()) throw new Error("describe the change");
    const id = formatId("CR", this.svc.db.next("CR"), 3);
    const dir = path.join(this.p.paths.attachments, id);
    const files = this.saveAttachments(dir, attachments).map((n) => path.join(dir, n));
    const now = new Date().toISOString();
    const cr: ChangeRequest = { id, text: text.trim(), status: "pm", created_at: now, updated_at: now, attachments: files };
    this.svc.patchState({ changes: [...this.changes(), cr] });
    this.svc.emit("change.requested", `Owner requested a change (${id}): ${cr.text.slice(0, 140)}`, { id }, { actor: "human" });
    this.createPlanningTask("pm", "change", { body: this.changeBody(cr), changeId: id });
    void this.tick();
    return cr;
  }

  cancelChange(id: string): void {
    const ch = this.changes().find((c) => c.id === id);
    if (!ch) throw new Error(`unknown change ${id}`);
    if (!["pm", "prd_review", "replan", "plan_review"].includes(ch.status)) throw new Error(`${id} is already ${ch.status}`);
    this.setChange(id, "cancelled");
    for (const t of this.svc.tasks({ kind: ["planning"] })) {
      if (t.meta.changeId === id && t.status !== "done") this.svc.setStatus(t.id, "done", { force: true, reason: `${id} cancelled` });
    }
    // Tasks imported for this change but never approved are dropped.
    for (const t of this.svc.tasks({ kind: ["build"] })) {
      if (t.hold === "plan" && t.status === "todo") {
        this.svc.db.run("DELETE FROM tasks WHERE id = ?", t.id);
        this.svc.db.run("DELETE FROM task_deps WHERE task = ?", t.id);
      }
    }
  }

  /** New work after the release review: back to the build, with fresh release checks later. */
  private reopenBuild(): void {
    for (const t of this.svc.tasks({ kind: ["release"] })) {
      if (t.status !== "done") this.svc.setStatus(t.id, "done", { force: true, reason: "superseded by a change request", extra: { hold: "superseded" } });
    }
    if (this.svc.doc("release")) this.svc.setDocStatus("release", "draft", "superseded by a change request", "orchestrator");
    this.svc.setPhase("build");
  }

  // ---------------------------------------------------------------------------------- questions

  /** An answer arrived (owner in the dashboard, or a teammate's `botss reply`). */
  async onAnswered(qid: string): Promise<void> {
    const q = this.svc.question(qid);
    if (!q) return;
    const answerText = typeof q.answer === "string" ? q.answer : JSON.stringify(q.answer, null, 2);
    const t = q.task ? this.svc.task(q.task) : null;
    if (t?.kind === "planning") {
      if (t.mode === "discover") {
        this.createPlanningTask("pm", "draft", {
          resume: {
            session: q.session_id ?? t.session_id ?? crypto.randomUUID(),
            prompt: `The owner answered your discovery questions (${q.id}):\n\n${answerText}\n\nNow switch to mode draft: write \`.botss/docs/prd.md\` and \`botss doc submit prd\`. Include only what the idea and these answers ask for.`,
          },
        });
      } else if (t.mode === "direction") {
        this.svc.patchState({ designChoice: answerText });
        this.svc.recordApproval("design_direction", null, null, "approved", answerText.slice(0, 500));
        this.svc.emit("design.direction", "Owner picked a design direction", { choice: answerText.slice(0, 500) }, { actor: q.answered_by });
        this.svc.setPhase("design");
        this.createPlanningTask("designer", "system", {
          resume: {
            session: q.session_id ?? t.session_id ?? crypto.randomUUID(),
            prompt: `The owner picked a direction (${q.id}):\n\n${answerText}\n\nNow switch to mode system: build the tokens, theme, and DESIGN.md for this direction, and commit.`,
          },
        });
      } else if (q.session_id) {
        // A planning agent asked something mid-run: rerun its mode on the same session with the answer.
        this.createPlanningTask(t.role, t.mode as RunMode, {
          resume: { session: q.session_id, prompt: `Answer to your question ${q.message_id}:\n\n${answerText}\n\nContinue in mode ${t.mode}.` },
          changeId: t.meta.changeId as string | undefined,
        });
      }
    } else if (t && t.status === "blocked") {
      const back = t.meta.resumeStatus ?? "in_progress";
      this.svc.setStatus(t.id, back === "ready" ? "ready" : back, {
        force: true,
        reason: `answer to ${q.message_id}`,
        extra: { blocked_on: null, blocked_reason: null, hold: null },
      });
      if (q.session_id) {
        this.svc.patchMeta(t.id, {
          resume: { session: q.session_id, prompt: `Your question ${q.message_id} was answered by ${q.answered_by}:\n\n${answerText}\n\nContinue the task.` },
          resumeStatus: undefined,
        });
      }
    }
    void this.tick();
  }

  private isBusy(taskId: string): boolean {
    return [...this.active.values()].some((r) => r.task === taskId) || this.finalizing.has(taskId);
  }

  /** Route a question to a teammate role. Questions to the same role are batched into one waiting answer
   * task, so one run answers several questions instead of paying for a run each. */
  routeQuestion(q: { id: string; messageId: string; to: string; body: string; from: string; task: string | null }): void {
    const target = q.to.replace(/^@/, "");
    const role = (this.p.roles.roles[target] ? target : target.replace(/-\d+$/, "")) as Role;
    if (!this.p.roles.roles[role]) return;
    const block = `## Question ${q.messageId} from ${q.from}${q.task ? ` (task ${q.task})` : ""}\n\n${q.body}\n\nReply with: \`botss reply ${q.messageId} "<answer>"\``;
    const waiting = this.svc.tasks({ kind: ["answer"], role }).find((t) => t.status === "ready" && !t.worktree && !this.isBusy(t.id));
    if (waiting) {
      const list = [...((waiting.meta.answersList as string[] | undefined) ?? [waiting.meta.answers!]), q.messageId];
      this.svc.updateTask(waiting.id, { body: `${waiting.body}\n\n${block}`, title: `Answer ${list.length} questions` });
      this.svc.patchMeta(waiting.id, { answersList: list });
      return;
    }
    const id = this.svc.nextId("A");
    this.svc.createTask({
      id,
      kind: "answer",
      mode: "answer",
      title: `Answer ${q.messageId} from ${q.from}`,
      role,
      status: "ready",
      priority: 1,
      body: block,
      meta: { answers: q.messageId, answersList: [q.messageId] },
    });
  }

  private async afterAnswerRun(t: TaskRow, run: ActiveRun, ok: boolean): Promise<void> {
    const ids = (t.meta.answersList as string[] | undefined) ?? (t.meta.answers ? [t.meta.answers] : []);
    const open = ids.filter((id) => this.svc.question(id)?.status !== "answered");
    if (t.worktree) {
      // Answer during the build: merge contract/doc changes like a task.
      await commitAll(t.worktree, `botss: answers by ${run.agent}`, ["-A", "--", ".botss/docs"]).catch(() => false);
      if (!open.length) {
        this.svc.setStatus(t.id, "review", { force: true, reason: "answered; merging" });
        await this.queueMerge(t.id);
        return;
      }
    } else {
      await this.commitIntegration(`botss: answers by ${run.agent}`);
      if (!open.length) {
        this.svc.setStatus(t.id, "done", { force: true, reason: "answered" });
        return;
      }
    }
    this.failRun(t, run, ok ? "run ended without `botss reply`" : "run failed", `You have not replied to ${open.join(", ")} yet. Reply with \`botss reply <id> "..."\`.`);
  }

  // ------------------------------------------------------------------------------------- merging

  private merging = new Set<string>();
  /** Worktrees of merged tasks, removed once no run is using them (a QA run may still be finishing in it). */
  private cleanup = new Set<string>();

  private sweeping = false;
  private async sweepWorktrees(): Promise<void> {
    if (this.sweeping || !this.cleanup.size) return;
    this.sweeping = true;
    try {
      await this.sweepOnce();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOnce(): Promise<void> {
    const busy = new Set([...this.active.values()].map((r) => path.resolve(r.cwd)));
    for (const dir of [...this.cleanup]) {
      if (busy.has(path.resolve(dir))) continue;
      this.cleanup.delete(dir);
      await removeWorktree(this.p.paths.root, dir).catch(() => {});
    }
  }

  queueMerge(taskId: string): Promise<void> {
    this.merging.add(taskId);
    const p = this.mergeChain.then(() => this.merge(taskId)).finally(() => this.merging.delete(taskId));
    this.mergeChain = p.catch(() => {});
    return this.track(p);
  }

  private async merge(taskId: string): Promise<void> {
    const t = this.svc.task(taskId);
    if (!t || t.status === "done") return;
    if (this.p.direct) return this.finishDirect(t);
    const integ = this.p.paths.integration;
    const branch = t.branch;
    if (!branch) {
      this.svc.setStatus(t.id, "done", { force: true, reason: "nothing to merge" });
      await this.afterMerged(t);
      return;
    }
    const pre = await headSha(integ);
    const r = await git(integ, ["merge", "--no-ff", "-m", `botss: merge ${t.id} ${t.title}`, branch], {
      reject: false,
    });
    if (r.code !== 0) {
      const conflicted = (
        await git(integ, ["diff", "--name-only", "--diff-filter=U"], { reject: false })
      ).stdout
        .split("\n")
        .filter(Boolean);
      await git(integ, ["merge", "--abort"], { reject: false });
      await git(integ, ["reset", "--hard", pre], { reject: false });
      this.svc.emit(
        "merge.conflict",
        `Merge of ${t.id} conflicts in ${conflicted.length} file(s): ${conflicted.slice(0, 5).join(", ")}`,
        { files: conflicted },
        { task: t.id },
      );
      this.createIntegrateTask(
        t,
        conflicted.length ? conflicted : await diffNames(integ, pre, branch),
        "merge conflict",
        r.stderr || r.stdout,
      );
      return;
    }
    const checks = this.svc.settings.checks;
    for (const cmd of checks) {
      const res = await runShell(cmd, {
        cwd: integ,
        env: this.envFor(await this.integrationAgent(), {}),
        timeoutMs: this.svc.settings.verify_timeout_minutes * 60_000,
      });
      if (res.code !== 0) {
        await git(integ, ["reset", "--hard", pre], { reject: false });
        this.svc.emit(
          "checks.failed",
          `Checks failed after merging ${t.id}: \`${cmd}\``,
          { command: cmd, output: res.output.slice(-4000) },
          { task: t.id },
        );
        this.createIntegrateTask(t, await diffNames(integ, pre, branch), `checks failed: ${cmd}`, res.output);
        return;
      }
    }
    const head = await headSha(integ);
    this.svc.setStatus(t.id, "done", {
      force: true,
      reason: "merged",
      extra: { head_sha: head, hold: null },
    });
    this.svc.emit(
      "merge.ok",
      `Merged ${t.id} into botss/integration (${head.slice(0, 7)})`,
      { head, checks: checks.length },
      { task: t.id },
    );
    await this.afterMerged(t);
  }

  /**
   * Direct mode "merge": the work is already in the project folder. Run the project's checks; if they fail,
   * the task still counts as done (its own verify passed) and the tech lead gets a repair task.
   */
  private async finishDirect(t: TaskRow): Promise<void> {
    const changed = ["build", "integrate", "release"].includes(t.kind) ? this.taskDiff(t).files : [];
    this.svc.setStatus(t.id, "done", { force: true, reason: "finished", extra: { hold: null } });
    this.svc.emit(
      "merge.ok",
      `${t.id} finished${changed.length ? `: ${changed.length} file(s) changed` : ""}`,
      { files: changed.slice(0, 50) },
      { task: t.id },
    );
    const checks = this.svc.settings.checks;
    for (const cmd of checks) {
      const res = await runShell(cmd, {
        cwd: this.p.paths.root,
        env: this.envFor(await this.integrationAgent(), {}),
        timeoutMs: this.svc.settings.verify_timeout_minutes * 60_000,
      });
      if (res.code !== 0) {
        this.svc.emit("checks.failed", `Project checks failed after ${t.id}: \`${cmd}\``, { command: cmd, output: res.output.slice(-4000) }, { task: t.id });
        const id = this.svc.nextId("I");
        this.svc.createTask({
          id,
          kind: "integrate",
          mode: "repair",
          title: `Repair checks after ${t.id}`,
          role: "tech-lead",
          status: "ready",
          priority: 0,
          owns: changed.length ? changed.map((c) => c.path) : t.owns,
          verify: checks.join(" && "),
          parent: null,
          body: `The project's checks failed after ${t.id} (${t.title}) finished.\n\n\`\`\`\n$ ${cmd}\n${res.output.slice(-3000)}\n\`\`\`\n\nFiles ${t.id} changed: ${changed.map((c) => c.path).join(", ") || "(see its handoff)"}\n\n## Handoff of ${t.id}\n\n${this.svc.handoffs(t.id).at(-1)?.content ?? "(none)"}`,
        });
        this.svc.alert(`Checks failed after ${t.id}. Repair task ${id} was created for the tech lead.`, t.id);
        break;
      }
    }
    await this.afterMerged(this.svc.task(t.id)!);
  }

  private async integrationAgent(): Promise<string> {
    const id = "integration";
    if (!this.svc.agent(id)) {
      const block = await allocatePortBlock(
        this.svc.settings.port_base,
        this.svc.agents().map((a) => a.port_block as number),
      );
      this.svc.upsertAgent(id, "devops", block);
    }
    return id;
  }

  private createIntegrateTask(t: TaskRow, files: string[], why: string, output: string): void {
    const id = this.svc.nextId("I");
    const related = this.svc
      .tasks({ kind: ["build", "integrate"] })
      .filter((o) => o.status === "done" && o.id !== t.id && files.some((f) => matchesAny(o.owns, f)))
      .map((o) => this.svc.handoffs(o.id).at(-1))
      .filter(Boolean);
    const mine = this.svc.handoffs(t.id).at(-1);
    const parent = t.kind === "integrate" && t.parent ? t.parent : t.id;
    this.svc.createTask({
      id,
      kind: "integrate",
      mode: "integrate",
      title: `Integrate ${t.id}: ${why}`,
      role: "tech-lead",
      status: "ready",
      priority: 0,
      owns: files.length ? files : t.owns,
      verify: this.svc.settings.checks.join(" && ") || t.verify || "true",
      parent,
      body: [
        `Merging \`${t.branch}\` (${t.id} ${t.title}) into \`botss/integration\` failed: ${why}.`,
        "",
        "```",
        output.slice(-3000),
        "```",
        "",
        `## Handoff of ${t.id}`,
        "",
        mine?.content ?? "(none)",
        ...related.map((h) => `\n## Handoff of ${h!.task}\n\n${h!.content}`),
      ].join("\n"),
      meta: { mergeBranch: t.branch ?? undefined },
    });
    this.svc.setStatus(parent, "blocked", {
      force: true,
      reason: `waiting for integration task ${id}`,
      extra: { hold: "integrating", blocked_on: id, blocked_reason: why },
    });
    this.svc.alert(
      `${t.id} could not be merged (${why}). Integration task ${id} was created for the tech lead.`,
      t.id,
    );
  }

  private async afterMerged(t: TaskRow): Promise<void> {
    this.svc.closeBugs(t.id);
    if (t.kind === "integrate" && t.parent) {
      const parent = this.svc.task(t.parent);
      if (parent && parent.status !== "done") {
        this.svc.setStatus(parent.id, "done", {
          force: true,
          reason: `merged through ${t.id}`,
          extra: { hold: null, blocked_on: null, blocked_reason: null },
        });
        if (parent.worktree) this.cleanup.add(parent.worktree);
      }
    }
    if (t.worktree) {
      this.cleanup.add(t.worktree);
      this.svc.updateTask(t.id, { worktree: null });
    }
    if ((t.id === "T000" || t.id === "T001") && t.kind === "build") this.captureChecks(t);
    if (t.kind === "planning") await this.onPlanningDone(t, t.session_id ?? "");
    await this.maybeAdvanceAfterBuild();
  }

  /** Check commands from the T000/T001 handoffs (a "## Checks" section, one command per line). */
  captureChecks(t: TaskRow): void {
    const h = this.svc.handoffs(t.id).at(-1)?.content ?? "";
    if (!this.captureChecksFrom(h, t.id) && t.id === "T000" && t.verify) this.addChecks([t.verify], t.id);
  }

  /** Returns true when the text had a Checks section. */
  captureChecksFrom(text: string, source: string): boolean {
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => /^#{2,}\s*Checks\s*$/i.test(l.trim()));
    if (at < 0) return false;
    const found: string[] = [];
    for (const raw of lines.slice(at + 1)) {
      if (/^#{1,2}\s/.test(raw)) break;
      const line = raw.trim().replace(/^[-*]\s+/, "").replace(/^`+|`+$/g, "").trim();
      if (!line || line.startsWith("```") || line.startsWith("#")) continue;
      found.push(line);
    }
    this.addChecks(found, source);
    return true;
  }

  private addChecks(found: string[], source: string): void {
    const cur = this.svc.settings.checks;
    const next = [...cur, ...found.filter((c) => !cur.includes(c))];
    if (next.length !== cur.length) {
      this.svc.updateSettings({ checks: next }, "orchestrator");
      this.svc.emit("project.checks", `Integration checks set from ${source}: ${found.join(" ; ")}`, { checks: next });
    }
  }

  private async maybeAdvanceAfterBuild(): Promise<void> {
    if (this.svc.phase === "build") {
      const work = this.svc.tasks({ kind: ["build", "integrate"] });
      if (work.length && work.every((x) => x.status === "done")) {
        if (this.svc.state.track === "quick") {
          // Quick track: no release QA round. Summarize what changed and tell the owner.
          this.svc.setPhase("release_review");
          await this.submitReleaseSummary();
          // (the summary may already have auto-approved the release when its gate is off)
          if ((this.svc.phase as string) === "release_review") await this.approve("release", "quick track", "auto");
        } else await this.enterRelease();
      }
    } else if (this.svc.phase === "release_review") {
      const rel = this.svc.tasks({ kind: ["release"] });
      if (rel.length && rel.every((x) => x.status === "done")) await this.submitReleaseSummary();
    }
  }

  private async enterRelease(): Promise<void> {
    this.svc.setPhase("release_review");
    const verify = this.svc.settings.checks.join(" && ") || "true";
    // A change request can reopen the build after a release review; each round gets fresh release tasks.
    const relId = (base: string) => {
      if (!this.svc.task(base)) return base;
      let n = 2;
      while (this.svc.task(`${base}-${n}`)) n++;
      return `${base}-${n}`;
    };
    this.svc.createTask({
      id: relId("REL-QA"),
      kind: "release",
      mode: "release",
      title: "Release QA on the merged branch",
      role: "qa",
      status: "ready",
      priority: 0,
      owns: ["e2e/**", ".botss/docs/qa/**"],
      verify,
      body: "Run the full suite and every PRD journey on the merged integration branch and report go or no-go.",
    });
    if (this.svc.settings.security_audit) {
      this.svc.createTask({
        id: relId("REL-SEC"),
        kind: "release",
        mode: "audit",
        title: "Pre-release security audit",
        role: "security",
        status: "ready",
        priority: 0,
        owns: [".botss/docs/security/**"],
        verify: "true",
        body: "Audit the merged branch and file bugs for real findings.",
      });
    }
  }

  async submitReleaseSummary(): Promise<void> {
    if (this.svc.doc("release")?.status === "submitted") return;
    const tasks = this.svc.tasks({ kind: ["build", "integrate", "release"] });
    const integ = this.p.sharedDir();
    const log = this.p.direct
      ? tasks.filter((x) => x.status === "done").map((x) => `${x.id} ${x.title}`).join("\n")
      : (await git(integ, ["log", "--oneline", "-n", "40"], { reject: false })).stdout;
    const t1 = this.svc.handoffs("T001").at(-1)?.content ?? this.svc.handoffs("T000").at(-1)?.content ?? "";
    const qa = this.svc.qaReports("REL-QA").at(-1)?.content ?? "";
    const usage = this.svc.usage(30);
    const md = [
      `# Release summary: ${this.p.paths.name}`,
      "",
      `Botss built ${tasks.filter((x) => x.kind === "build").length} tasks on the \`botss/integration\` branch. Approve to finish; then merge \`botss/integration\` into your main branch yourself when you are ready (Botss never does).`,
      "",
      "## What was built",
      "",
      "| Task | Title | Role |",
      "|---|---|---|",
      ...tasks.map((x) => `| ${x.id} | ${x.title.replace(/\|/g, "/")} | ${x.role} |`),
      "",
      "## How to run it",
      "",
      t1 ? t1 : "See the README and the T000/T001 handoffs.",
      "",
      "## Release QA",
      "",
      qa || "(no report)",
      "",
      "## Recent commits",
      "",
      "```",
      log,
      "```",
      "",
      `## Usage\n\nBudget tokens used in the last 30 days: ${usage.byDay.reduce((a, d) => a + (d.tokens ?? 0), 0).toLocaleString()}.`,
    ].join("\n");
    this.svc.submitDoc("release", ".botss/docs/release.md", md, "orchestrator", null);
    if (!this.gateEnabled("release")) await this.approve("release", "auto-approved (gate off)", "auto");
  }

  /** QA or review verdicts on release tasks. */
  async onReleaseTaskFinished(t: TaskRow): Promise<void> {
    await this.queueMerge(t.id);
  }

  // ------------------------------------------------------------------------------------ controls

  pause(reason = "paused by owner"): void {
    this.svc.patchState({ paused: true, pauseReason: reason });
    this.svc.emit("project.paused", `Scheduler paused: ${reason}`, {}, { actor: "human" });
  }

  resume(): void {
    this.svc.patchState({ paused: false, pauseReason: null, limitedUntil: null });
    for (const t of this.svc.tasks())
      if (t.hold === "killed" || t.hold === "error") this.svc.updateTask(t.id, { hold: null });
    this.svc.emit("project.resumed", "Scheduler resumed", {}, { actor: "human" });
    void this.tick();
  }

  /** Kill switch: stop every agent process now and pause. */
  async killAll(): Promise<number> {
    this.svc.patchState({ paused: true, pauseReason: "kill switch" });
    const runs = [...this.active.values()];
    for (const r of runs) {
      if (r.task)
        this.prepareRetry(
          r.task,
          r.sessionId,
          "You were stopped by the owner's kill switch. When resumed, check `git status` and `botss task show $BOTSS_TASK`, then continue.",
        );
    }
    await this.p.runner.killAll();
    await this.idle();
    this.svc.emit(
      "project.killed",
      `Kill switch: stopped ${runs.length} agent run(s)`,
      { runs: runs.map((r) => r.runId) },
      { actor: "human" },
    );
    return runs.length;
  }

  /** Pause: stop the run and keep its session, so Resume continues where it was. Kill: stop the run and drop the
   * session, so Resume starts the task over in a fresh session (useful when an agent went down a bad path). */
  async killAgent(agent: string, mode: "pause" | "kill" = "pause"): Promise<void> {
    const r = [...this.active.values()].find((x) => x.agent === agent);
    if (!r) return;
    if (r.task) {
      if (mode === "pause") {
        this.prepareRetry(r.task, r.sessionId, "You were paused by the owner. Continue the task from where you left off.");
      } else {
        this.svc.patchMeta(r.task, { resume: null });
        this.svc.updateTask(r.task, { session_id: null });
      }
      this.svc.updateTask(r.task, { hold: "paused" });
    }
    await this.p.runner.kill(r.runId);
    await this.idle();
    this.svc.emit(
      mode === "pause" ? "agent.paused" : "agent.killed",
      mode === "pause" ? `Owner paused ${agent}` : `Owner stopped ${agent}; the task restarts fresh when resumed`,
      {},
      { actor: "human", task: r.task },
    );
  }

  resumeTask(taskId: string): void {
    this.svc.updateTask(taskId, { hold: null });
    void this.tick();
  }

  activeRuns(): ActiveRun[] {
    return [...this.active.values()];
  }

  // ------------------------------------------------------------------------------------- preview

  async preview(
    action: "start" | "stop" | "reset",
  ): Promise<{ ok: boolean; output: string; url: string | null }> {
    const agent = await this.integrationAgent();
    const env = this.envFor(agent, {});
    const cmd =
      action === "start"
        ? "docker compose up -d --build"
        : action === "stop"
          ? "docker compose down"
          : "docker compose down -v && docker compose up -d --build";
    const r = await runShell(cmd, { cwd: this.p.sharedDir(), env, timeoutMs: 15 * 60_000 });
    this.svc.patchState({ previewRunning: action !== "stop" && r.code === 0 });
    this.svc.emit(
      "preview.changed",
      `Preview ${action}: ${r.code === 0 ? "ok" : "failed"}`,
      { action, code: r.code },
      { actor: "human" },
    );
    return {
      ok: r.code === 0,
      output: r.output.slice(-6000),
      url: r.code === 0 && action !== "stop" ? `http://127.0.0.1:${env.FRONTEND_PORT}` : null,
    };
  }

  previewUrl(): string | null {
    const a = this.svc.agent("integration");
    return a && this.svc.state.previewRunning ? `http://127.0.0.1:${(a.port_block as number) + 2}` : null;
  }
}

export { PLANNING_ROLES };
