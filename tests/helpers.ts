import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BotssServer, ClaudeRunner, git, initProject, type Project } from "@botss/server";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_CLAUDE = path.join(REPO, "packages/fake-claude/src/main.ts");

export interface Harness {
  dir: string;
  root: string;
  server: BotssServer;
  project: Project;
  stateDir: string;
  api: (method: string, p: string, body?: unknown) => Promise<any>;
  invocations: () => any[];
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

/** Scenario steps that finish a build task the normal way. */
export function implementSteps(file = "src/${BOTSS_TASK}.txt", content = "work of ${BOTSS_TASK}\n", status = "DONE") {
  return [
    { botss: ["whoami"] },
    { botss: ["task", "start", "${BOTSS_TASK}"] },
    { write: file, content },
    { bash: `git add -A && git commit -q -m "\${BOTSS_TASK}: work"` },
    { write: ".botss/handoffs/${BOTSS_TASK}.md", content: "# Handoff: ${BOTSS_TASK}\n\n## What changed\nDid it.\n\n## Checks\n- `test -d .botss`\n" },
    { botss: ["progress", "Finished ${BOTSS_TASK}"] },
    { botss: ["task", "done", "${BOTSS_TASK}", "--status", status, "--handoff", ".botss/handoffs/${BOTSS_TASK}.md"] },
  ];
}

export const reviewApprove = [{ botss: ["review", "start", "${BOTSS_TASK}"] }, { botss: ["review", "approve", "${BOTSS_TASK}", "--summary", "Looks good"] }];

export const qaPass = [
  { write: ".botss/reviews/${BOTSS_TASK}-qa.md", content: "# QA ${BOTSS_TASK}\n\nAll criteria pass.\n" },
  { botss: ["qa", "pass", "${BOTSS_TASK}", "--report", ".botss/reviews/${BOTSS_TASK}-qa.md"] },
];

export const DEFAULT_BUILD_SCENARIO: Record<string, unknown> = {
  "tech-lead:scaffold": { steps: implementSteps() },
  "tech-lead:implement": { steps: implementSteps() },
  "devops:implement": { steps: implementSteps() },
  "backend:implement": { steps: implementSteps() },
  "frontend:implement": { steps: implementSteps() },
  "backend:fix": { steps: implementSteps("src/${BOTSS_TASK}.txt", "fixed ${BOTSS_TASK}\n") },
  "frontend:fix": { steps: implementSteps("src/${BOTSS_TASK}.txt", "fixed ${BOTSS_TASK}\n") },
  "reviewer:review": { steps: reviewApprove },
  "qa:verify": { steps: qaPass },
  "qa:release": { steps: qaPass },
};

export function taskFile(id: string, f: { role: string; after?: string[]; owns?: string[]; may_touch?: string[]; verify?: string; title?: string; size?: string }): string {
  const lines = [
    "---",
    `id: ${id}`,
    `title: ${f.title ?? `Task ${id}`}`,
    `role: ${f.role}`,
    `after: [${(f.after ?? []).join(", ")}]`,
    `owns: [${(f.owns ?? [`src/${id}.txt`]).map((o) => JSON.stringify(o)).join(", ")}]`,
    `may_touch: [${(f.may_touch ?? []).map((o) => JSON.stringify(o)).join(", ")}]`,
    `verify: ${JSON.stringify(f.verify ?? `test -f src/${id}.txt`)}`,
    `size: ${f.size ?? "S"}`,
    "---",
    "",
    "## Goal",
    `Build ${id}.`,
    "",
    "## Acceptance criteria",
    `1. Given nothing, when ${id} is built, then src/${id}.txt exists.`,
    "",
  ];
  return lines.join("\n");
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 60_000, every = 100): Promise<NonNullable<T>> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ""}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

export async function startHarness(scenario: Record<string, unknown>, opts: { name?: string; settings?: Record<string, unknown>; workspace?: "direct" | "isolated" } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "botss-e2e-"));
  const root = path.join(dir, opts.name ?? "sample app");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Sample app\n");
  fs.writeFileSync(path.join(root, "src", ".gitkeep"), "");
  // Direct mode needs no git at all: test it on a plain folder.
  if (opts.workspace !== "direct") {
    await git(root, ["init", "-q", "-b", "main"]);
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "sample project"]);
  }
  const stateDir = path.join(dir, "fake-state");
  const scenarioFile = path.join(dir, "scenario.json");
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));
  process.env.BOTSS_HOME = path.join(dir, "home");
  process.env.BOTSS_FAKE_SCENARIO = scenarioFile;
  process.env.BOTSS_FAKE_STATE = stateDir;
  await initProject(root, { workspace: opts.workspace ?? "isolated" });

  const h: Partial<Harness> = { dir, root, stateDir };
  const boot = async () => {
    const server = new BotssServer({ port: 0, writeInfo: false, runnerFactory: () => new ClaudeRunner(FAKE_CLAUDE), autoStart: false });
    await server.start();
    const project = await server.openProject(root);
    project.svc.updateSettings({ scheduler_interval_ms: 150, port_base: 32000 + Math.floor(Math.random() * 200) * 50, verify_timeout_minutes: 1, existing: false, ...(opts.settings ?? {}) } as any);
    project.start();
    h.server = server;
    h.project = project;
  };
  await boot();
  h.api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${h.server!.url}/api/projects/${h.project!.id}${p}`, {
      method,
      headers: { authorization: `Bearer ${h.server!.tokens.master}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  h.invocations = () => {
    const f = path.join(stateDir, "invocations.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  h.stop = async () => {
    await h.server!.stop();
  };
  h.restart = async () => {
    await h.server!.stop();
    await boot();
  };
  return h as Harness;
}

/** Skip planning: import tasks and open the build phase directly. */
export async function seedBuild(h: Harness, files: Record<string, string>): Promise<void> {
  const { checkPlan } = await import("@botss/core");
  const r = checkPlan(Object.entries(files).map(([file, source]) => ({ file, source })));
  if (r.problems.some((p) => p.code !== "collision")) throw new Error(JSON.stringify(r.problems));
  h.project.svc.importPlan(r.tasks, "test");
  h.project.svc.setPhase("build");
  await h.project.orch.tick();
}

export function events(h: Harness, type: string) {
  return h.project.svc.events({ types: [type], limit: 5000 });
}

export async function cleanup(h: Harness | undefined): Promise<void> {
  if (!h) return;
  // Debug aid: BOTSS_TEST_DUMP=<file> writes the event log and runs of the last test.
  if (process.env.BOTSS_TEST_DUMP) {
    try {
      const lines = h.project.svc.events({ limit: 5000 }).map((e) => `${e.ts.slice(11, 23)} ${e.type} | ${e.actor ?? ""} | ${e.task ?? ""} | ${e.summary}`);
      for (const r of h.project.svc.runs({ limit: 100 })) lines.push(`RUN ${r.id} ${r.agent} ${r.task} ${r.stage} ${r.result_status} ${r.result_text ?? ""}`);
      fs.writeFileSync(process.env.BOTSS_TEST_DUMP, lines.join("\n"));
    } catch {
      /* ignore */
    }
  }
  try {
    await h.stop();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(h.dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* windows file locks */
  }
}
