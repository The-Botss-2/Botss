import { estimateBuild, GATES, planStats, quotaCheck, settingsSchema, type Gate, type Identity } from "@botss/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CmdResult } from "./commands.ts";
import { commitAll, git } from "./git.ts";
import { SKILLS_SOURCE } from "./paths.ts";
import type { Project } from "./project.ts";
import { readRegistry } from "./registry.ts";
import { safeJoin } from "./safe-path.ts";
import { ServiceError } from "./service.ts";
import type { BotssServer } from "./server.ts";

type Req = FastifyRequest & { identity?: Identity; tokenProject?: string | null };

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return undefined;
}

function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof ServiceError) {
    const status = e.code === 3 ? 403 : e.code === 404 ? 404 : e.code === 409 ? 409 : 400;
    return reply.code(status).send({ error: e.message, exit: e.code === 404 || e.code === 409 ? 2 : e.code });
  }
  if (e instanceof z.ZodError) return reply.code(400).send({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), exit: 2 });
  const msg = (e as Error)?.message ?? String(e);
  return reply.code(400).send({ error: msg, exit: 2 });
}

export function registerApi(app: FastifyInstance, srv: BotssServer): void {
  // ---------------------------------------------------------------------------------------- auth
  app.addHook("onRequest", async (req: Req, reply) => {
    // DNS-rebinding guard: only answer requests addressed to loopback.
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return reply.code(421).send({ error: "botss only answers on 127.0.0.1" });
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/health")) return;
    const q = (req.query as Record<string, string> | undefined) ?? {};
    const token = bearer(req) ?? (req.url.startsWith("/api/ws") ? q.token : undefined);
    const who = srv.tokens.resolve(token);
    if (!who) return reply.code(401).send({ error: "missing or invalid token", exit: 3 });
    req.identity = who.identity;
    req.tokenProject = who.projectId;
  });

  const project = (req: Req): Project => {
    const pid = (req.params as { pid: string }).pid;
    if (req.tokenProject && req.tokenProject !== pid) throw new ServiceError("token is not valid for this project", 3);
    const p = srv.projects.get(pid);
    if (!p) throw new ServiceError(`unknown project ${pid}`, 404);
    return p;
  };
  const human = (req: Req): void => {
    if (req.identity?.kind !== "human") throw new ServiceError("owner token required", 3);
  };
  const wrap =
    (fn: (req: Req, reply: FastifyReply) => unknown) =>
    async (req: Req, reply: FastifyReply) => {
      try {
        const out = await fn(req, reply);
        if (reply.sent) return;
        return out ?? { ok: true };
      } catch (e) {
        return sendError(reply, e);
      }
    };

  app.get("/api/health", async () => ({ ok: true, name: "botss", version: "0.1.0" }));

  // ------------------------------------------------------------------------------------ projects
  app.get(
    "/api/projects",
    wrap((req) => {
      human(req);
      return readRegistry().map((e) => {
        const p = srv.projects.get(e.id);
        return { ...e, open: Boolean(p), phase: p?.svc.phase ?? null, exists: fs.existsSync(path.join(e.root, ".botss")) };
      });
    }),
  );

  app.post(
    "/api/projects",
    wrap(async (req) => {
      human(req);
      const body = z.object({ root: z.string().min(1), init: z.boolean().optional() }).parse(req.body);
      const p = await srv.openProject(body.root, { init: body.init });
      return { id: p.id, name: p.paths.name, root: p.paths.root };
    }),
  );

  // ------------------------------------------------------------------------- agent CLI commands
  app.post(
    "/api/projects/:pid/cmd/:name",
    wrap(async (req) => {
      const p = project(req);
      const name = (req.params as { name: string }).name;
      const b = (req.body ?? {}) as Record<string, any>;
      const id = req.identity!;
      const c = p.cmds;
      const s = (k: string) => (b[k] === undefined || b[k] === null ? "" : String(b[k]));
      let r: CmdResult;
      switch (name) {
        case "whoami":
          r = c.whoami(id);
          break;
        case "task.show":
          r = c.taskShow(id, s("task"));
          break;
        case "task.list":
          r = c.taskList(id, { ready: Boolean(b.ready), role: b.role, status: b.status });
          break;
        case "task.start":
          r = c.taskStart(id, s("task"));
          break;
        case "task.block":
          r = c.taskBlock(id, s("task"), s("on"), s("reason"));
          break;
        case "task.unblock":
          r = c.taskUnblock(id, s("task"));
          break;
        case "task.done":
          r = await c.taskDone(id, s("task"), s("status"), b.handoff ?? null);
          break;
        case "progress":
          r = c.progress(id, s("text"));
          break;
        case "msg":
          r = c.msg(id, s("to"), s("body"));
          break;
        case "ask":
          r = c.ask(id, s("to"), b.body ?? null, b.batch ?? null);
          break;
        case "inbox":
          r = c.inbox(id, Boolean(b.all));
          break;
        case "reply":
          r = await c.reply(id, s("id"), s("body"));
          break;
        case "decision":
          r = c.decision(id, s("title"), s("why"), Array.isArray(b.affects) ? b.affects : []);
          break;
        case "decision.list":
          r = c.decisionList(id);
          break;
        case "decision.show":
          r = c.decisionShow(id, s("id"));
          break;
        case "doc.list":
          r = c.docList(id);
          break;
        case "doc.show":
          r = c.docShow(id, s("name"));
          break;
        case "doc.submit":
          r = await c.docSubmit(id, s("name"), s("content"), b.file ?? null);
          break;
        case "plan.check":
          r = await c.planCheck(id, b.files ?? []);
          break;
        case "plan.submit":
          r = await c.planSubmit(id, b.files ?? [], b.summary ?? null);
          break;
        case "review.start":
          r = c.reviewStart(id, s("task"));
          break;
        case "review.comment":
          r = c.reviewComment(id, s("task"), { file: b.file, line: b.line ? Number(b.line) : undefined, severity: s("severity") || "minor", body: s("body") });
          break;
        case "review.approve":
          r = c.reviewApprove(id, s("task"), s("summary"));
          break;
        case "review.request-changes":
          r = c.reviewRequestChanges(id, s("task"), s("summary"), b.content ?? null);
          break;
        case "qa.pass":
          r = await c.qaPass(id, s("task"), s("report"));
          break;
        case "qa.fail":
          r = c.qaFail(id, s("task"), s("report"));
          break;
        case "bug.create":
          r = c.bugCreate(id, { task: s("task"), severity: s("severity"), title: s("title"), content: s("content") });
          break;
        default:
          throw new ServiceError(`unknown command ${name}`, 2);
      }
      return { ok: !r.exit, text: r.text, data: r.data ?? null, exit: r.exit ?? 0 };
    }),
  );

  app.post(
    "/api/projects/:pid/guard-block",
    wrap((req) => {
      const p = project(req);
      const b = (req.body ?? {}) as { tool?: string; reason?: string; target?: string };
      const id = req.identity!;
      const actor = id.kind === "agent" ? id.agent : "human";
      p.svc.emit("guard.blocked", `Guard blocked ${actor}: ${b.reason ?? b.tool}`, { tool: b.tool, target: b.target ?? null }, {
        actor,
        role: id.kind === "agent" ? id.role : null,
        task: id.kind === "agent" ? id.task : null,
        run: id.kind === "agent" ? id.runId : null,
      });
      return { ok: true };
    }),
  );

  // ----------------------------------------------------------------------------- dashboard reads
  app.get(
    "/api/projects/:pid",
    wrap((req) => {
      human(req);
      const p = project(req);
      const proj = p.svc.project();
      const quota = quotaCheck(proj.settings, { usedToday: p.svc.usedToday(), limitedUntil: proj.state.limitedUntil ?? null });
      const counts: Record<string, number> = {};
      for (const t of p.svc.tasks({ kind: ["build", "integrate", "release"] })) counts[t.status] = (counts[t.status] ?? 0) + 1;
      return {
        id: p.id,
        ...proj,
        quota: { ...quota, allowance: Number.isFinite(quota.allowance) ? quota.allowance : null, usedToday: p.svc.usedToday() },
        counts,
        activeRuns: p.orch.activeRuns().length,
        openQuestions: p.svc.questions("open").filter((q) => q.to_addr === "@human").length,
        previewUrl: p.orch.previewUrl(),
        roles: p.roles.roles,
        defaultStack: p.roles.default_stack,
      };
    }),
  );

  app.patch(
    "/api/projects/:pid/settings",
    wrap((req) => {
      human(req);
      const p = project(req);
      const patch = settingsSchema.partial().parse(req.body);
      return p.svc.updateSettings(patch);
    }),
  );

  app.post(
    "/api/projects/:pid/idea",
    wrap(async (req) => {
      human(req);
      const p = project(req);
      const b = z
        .object({
          text: z.string().min(3).max(50_000),
          stakes: z.string().max(200).optional(),
          links: z.array(z.string().max(2000)).max(50).optional(),
          attachments: z.array(z.object({ name: z.string().max(200), data: z.string().max(14_000_000) })).max(20).optional(),
        })
        .parse(req.body);
      await p.orch.submitIdea(b);
      return { ok: true };
    }),
  );

  app.get(
    "/api/projects/:pid/tasks",
    wrap((req) => {
      human(req);
      return project(req)
        .svc.tasks()
        .map(({ source: _s, ...t }) => ({ ...t, bugs: 0 }))
        .map((t) => ({ ...t, bugs: project(req).svc.bugs(t.id, "open").length }));
    }),
  );

  app.get(
    "/api/projects/:pid/tasks/:id",
    wrap((req) => {
      human(req);
      const p = project(req);
      const id = (req.params as { id: string }).id;
      const t = p.svc.mustTask(id);
      return {
        task: t,
        reviews: p.svc.reviews(id),
        bugs: p.svc.bugs(id),
        handoffs: p.svc.handoffs(id),
        qa: p.svc.qaReports(id),
        messages: p.svc.messages({ task: id }),
        runs: p.svc.runs({ task: id }),
        events: p.svc.events({ task: id, limit: 400 }),
      };
    }),
  );

  app.get(
    "/api/projects/:pid/tasks/:id/diff",
    wrap(async (req) => {
      human(req);
      const p = project(req);
      const t = p.svc.mustTask((req.params as { id: string }).id);
      if (!t.base_sha || !t.branch) return { diff: "" };
      const r = await git(p.paths.root, ["diff", "--no-color", `${t.base_sha}...${t.head_sha ?? t.branch}`], { reject: false });
      return { diff: r.stdout.slice(0, 2_000_000), base: t.base_sha, head: t.head_sha ?? t.branch };
    }),
  );

  app.post(
    "/api/projects/:pid/tasks/:id/:action",
    wrap((req) => {
      human(req);
      const p = project(req);
      const { id, action } = req.params as { id: string; action: string };
      const t = p.svc.mustTask(id);
      switch (action) {
        case "unblock":
          p.svc.setStatus(id, t.meta.resumeStatus ?? (t.kind === "release" ? "ready" : "in_progress"), {
            force: true,
            actor: "human",
            reason: "unblocked by owner",
            extra: { hold: null, blocked_on: null, blocked_reason: null, run_failures: 0, verify_failures: 0 },
          });
          break;
        case "hold":
          p.svc.updateTask(id, { hold: "paused" });
          break;
        case "release":
          p.orch.resumeTask(id);
          break;
        default:
          throw new ServiceError(`unknown action ${action}`, 2);
      }
      void p.orch.tick();
      return { ok: true };
    }),
  );

  app.get("/api/projects/:pid/docs", wrap((req) => (human(req), project(req).svc.docs())));
  app.get(
    "/api/projects/:pid/docs/*",
    wrap((req) => {
      human(req);
      const p = project(req);
      const name = (req.params as { "*": string })["*"];
      const m = /^(.*)\/versions\/(\d+)$/.exec(name);
      if (m) {
        const v = p.svc.docVersion(m[1]!, Number(m[2]));
        if (!v) throw new ServiceError("no such version", 404);
        return v;
      }
      const d = p.svc.doc(name);
      if (!d) throw new ServiceError(`unknown document ${name}`, 404);
      return d;
    }),
  );
  app.post(
    "/api/projects/:pid/docs-comment",
    wrap((req) => {
      human(req);
      const b = z.object({ doc: z.string(), body: z.string().min(1).max(10_000), anchor: z.string().max(500).nullable().optional() }).parse(req.body);
      project(req).svc.commentDoc(b.doc, b.body, b.anchor ?? null);
      return { ok: true };
    }),
  );

  app.post(
    "/api/projects/:pid/gates/:gate/:decision",
    wrap(async (req) => {
      human(req);
      const p = project(req);
      const { gate, decision } = req.params as { gate: string; decision: string };
      if (!(GATES as readonly string[]).includes(gate)) throw new ServiceError(`unknown gate ${gate}`, 2);
      const b = z.object({ comment: z.string().max(20_000).optional(), team: z.record(z.string(), z.number().int().min(0).max(16)).optional() }).parse(req.body ?? {});
      if (decision === "approve") await p.orch.approve(gate as Gate, b.comment ?? null, "human", b.team);
      else if (decision === "request-changes") {
        if (!b.comment?.trim()) throw new ServiceError("a comment is required when requesting changes", 2);
        await p.orch.requestChanges(gate as Gate, b.comment);
      } else throw new ServiceError(`unknown decision ${decision}`, 2);
      return { ok: true };
    }),
  );

  app.get(
    "/api/projects/:pid/questions",
    wrap((req) => {
      human(req);
      const st = (req.query as { status?: string }).status;
      return project(req).svc.questions(st);
    }),
  );
  app.post(
    "/api/projects/:pid/questions/:qid/answer",
    wrap(async (req) => {
      human(req);
      const b = z.object({ answer: z.unknown() }).parse(req.body);
      return project(req).cmds.answerQuestion(req.identity!, (req.params as { qid: string }).qid, b.answer);
    }),
  );

  app.get("/api/projects/:pid/messages", wrap((req) => (human(req), project(req).svc.messages({ limit: 500 }))));
  app.post(
    "/api/projects/:pid/messages",
    wrap((req) => {
      human(req);
      const b = z.object({ to: z.string(), body: z.string().min(1).max(10_000) }).parse(req.body);
      return project(req).cmds.msg(req.identity!, b.to, b.body);
    }),
  );
  app.get("/api/projects/:pid/decisions", wrap((req) => (human(req), project(req).svc.decisions())));

  app.get(
    "/api/projects/:pid/agents",
    wrap((req) => {
      human(req);
      const p = project(req);
      const active = new Map(p.orch.activeRuns().map((r) => [r.agent, r]));
      return p.svc.agents().map((a) => {
        const r = a.current_run ? p.svc.run(a.current_run) : null;
        const tokens = r ? Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_creation_tokens) : 0;
        return { ...a, active: active.has(a.id), run: r, tokens };
      });
    }),
  );
  app.get("/api/projects/:pid/runs", wrap((req) => (human(req), project(req).svc.runs({ limit: 300 }))));
  app.get(
    "/api/projects/:pid/runs/:rid/stream",
    wrap((req) => {
      human(req);
      const p = project(req);
      const rid = (req.params as { rid: string }).rid;
      if (!/^R-\d+$/.test(rid)) throw new ServiceError("bad run id", 2);
      const f = path.join(p.paths.run(rid), "stream.jsonl");
      if (!fs.existsSync(f)) return { lines: [] };
      const text = fs.readFileSync(f, "utf8");
      return { lines: text.split("\n").filter(Boolean).slice(-400) };
    }),
  );
  app.get(
    "/api/projects/:pid/events",
    wrap((req) => {
      human(req);
      const q = req.query as { after?: string; task?: string; limit?: string; types?: string; run?: string };
      return project(req).svc.events({
        after: q.after ? Number(q.after) : undefined,
        task: q.task,
        run: q.run,
        limit: q.limit ? Number(q.limit) : 1000,
        types: q.types ? q.types.split(",") : undefined,
      });
    }),
  );
  app.get(
    "/api/projects/:pid/usage",
    wrap((req) => {
      human(req);
      const p = project(req);
      const u = p.svc.usage(7);
      return { ...u, limits: p.svc.events({ types: ["quota.*"], limit: 50 }), settings: { daily_token_budget: p.svc.settings.daily_token_budget, reserve_percent: p.svc.settings.reserve_percent } };
    }),
  );

  app.get(
    "/api/projects/:pid/plan",
    wrap((req) => {
      human(req);
      const p = project(req);
      const tasks = p.svc.tasks({ kind: ["build"] });
      const stats = tasks.length ? planStats(tasks) : null;
      const est = estimateBuild(stats?.byRole ?? {}, p.svc.avgTokensByRole(), p.svc.settings.qa_per_task);
      return { tasks: tasks.map(({ source: _s, body: _b, ...t }) => t), stats, estimate: est, team: p.svc.settings.team };
    }),
  );

  // -------------------------------------------------------------------------------- controls
  app.post(
    "/api/projects/:pid/control/:action",
    wrap(async (req) => {
      human(req);
      const p = project(req);
      const action = (req.params as { action: string }).action;
      if (action === "pause") p.orch.pause();
      else if (action === "resume") p.orch.resume();
      else if (action === "kill") return { killed: await p.orch.killAll() };
      else if (action === "dismiss-alert") p.svc.dismissAlert(Number((req.body as { id?: number })?.id));
      else throw new ServiceError(`unknown action ${action}`, 2);
      return { ok: true };
    }),
  );
  app.post(
    "/api/projects/:pid/agents/:agent/:action",
    wrap(async (req) => {
      human(req);
      const p = project(req);
      const { agent, action } = req.params as { agent: string; action: string };
      if (action === "kill" || action === "pause") await p.orch.killAgent(agent);
      else if (action === "resume") {
        for (const t of p.svc.tasks()) if (t.hold === "paused" && t.assignee === agent) p.orch.resumeTask(t.id);
      } else throw new ServiceError(`unknown action ${action}`, 2);
      return { ok: true };
    }),
  );
  app.post(
    "/api/projects/:pid/preview/:action",
    wrap(async (req) => {
      human(req);
      const action = (req.params as { action: string }).action;
      if (!["start", "stop", "reset"].includes(action)) throw new ServiceError("unknown preview action", 2);
      return project(req).orch.preview(action as "start" | "stop" | "reset");
    }),
  );

  // ---------------------------------------------------------------------------------- design
  app.get(
    "/api/projects/:pid/design",
    wrap((req) => {
      human(req);
      const p = project(req);
      const base = path.join(p.paths.integration, ".botss/docs");
      const screensDir = path.join(base, "design/screens");
      const screens = fs.existsSync(screensDir) ? fs.readdirSync(screensDir).filter((f) => /\.(html|md)$/.test(f)).sort() : [];
      const tokensFile = path.join(base, "contracts/design-tokens.json");
      let tokens: unknown;
      try {
        tokens = fs.existsSync(tokensFile) ? JSON.parse(fs.readFileSync(tokensFile, "utf8")) : null;
      } catch {
        tokens = null;
      }
      const directions = p.svc.questions().filter((q) => q.kind === "batch" && p.svc.task(q.task ?? "")?.mode === "direction");
      return { choice: p.svc.state.designChoice ?? null, directions, tokens, screens };
    }),
  );
  app.get(
    "/api/projects/:pid/design/screen",
    wrap((req, reply) => {
      human(req);
      const p = project(req);
      const name = (req.query as { name?: string }).name ?? "";
      if (!/^[A-Za-z0-9._-]+\.(html|md)$/.test(name)) throw new ServiceError("bad screen name", 2);
      const f = safeJoin(path.join(p.paths.integration, ".botss/docs/design/screens"), name);
      if (!f || !fs.existsSync(f)) throw new ServiceError("not found", 404);
      // Served as text and rendered by the dashboard in a sandboxed iframe (srcdoc, no allow-same-origin).
      return reply.header("content-type", "text/plain; charset=utf-8").header("content-security-policy", "sandbox").send(fs.readFileSync(f, "utf8"));
    }),
  );

  // ---------------------------------------------------------------------------------- skills
  const skillsBase = (p: Project) => path.join(p.paths.integration, ".botss/skills");
  const listFiles = (dir: string, prefix = ""): string[] =>
    fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`) : e.isFile() ? [`${prefix}${e.name}`] : []))
      : [];
  app.get(
    "/api/projects/:pid/skills",
    wrap((req) => {
      human(req);
      const p = project(req);
      const files = listFiles(skillsBase(p));
      return { files, roles: Object.fromEntries(Object.entries(p.roles.roles).map(([k, v]) => [k, v.skills])) };
    }),
  );
  app.get(
    "/api/projects/:pid/skills/file",
    wrap((req) => {
      human(req);
      const p = project(req);
      const rel = (req.query as { path?: string }).path ?? "";
      const f = safeJoin(skillsBase(p), rel);
      if (!f || !fs.existsSync(f) || !fs.statSync(f).isFile()) throw new ServiceError("not found", 404);
      const def = safeJoin(SKILLS_SOURCE, rel);
      const original = def && fs.existsSync(def) ? fs.readFileSync(def, "utf8") : null;
      const content = fs.readFileSync(f, "utf8");
      return { path: rel, content, modified: original !== null && original !== content, hasDefault: original !== null };
    }),
  );
  app.put(
    "/api/projects/:pid/skills/file",
    wrap(async (req) => {
      human(req);
      const p = project(req);
      const b = z.object({ path: z.string().regex(/^[A-Za-z0-9._\-/]+\.(md|json|yaml|yml|txt)$|Makefile$|env\.example$/), content: z.string().max(400_000) }).parse(req.body);
      const f = safeJoin(skillsBase(p), b.path);
      if (!f) throw new ServiceError("invalid path", 2);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, b.content);
      await commitAll(p.paths.integration, `botss: owner edited skill ${b.path}`, ["-A", "--", ".botss/skills"]);
      p.svc.emit("skills.updated", `Owner edited skill file ${b.path}`, { path: b.path }, { actor: "human" });
      return { ok: true };
    }),
  );
  app.post(
    "/api/projects/:pid/skills/reset",
    wrap(async (req) => {
      human(req);
      const p = project(req);
      const rel = z.object({ path: z.string() }).parse(req.body).path;
      const src = safeJoin(SKILLS_SOURCE, rel);
      const dst = safeJoin(skillsBase(p), rel);
      if (!src || !dst || !fs.existsSync(src)) throw new ServiceError("no default for that file", 404);
      fs.copyFileSync(src, dst);
      await commitAll(p.paths.integration, `botss: reset skill ${rel} to default`, ["-A", "--", ".botss/skills"]);
      p.svc.emit("skills.updated", `Owner reset ${rel} to the default`, { path: rel }, { actor: "human" });
      return { ok: true };
    }),
  );
}
