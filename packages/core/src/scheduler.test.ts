import { describe, expect, it } from "vitest";
import { authorize, type Identity } from "./permissions.ts";
import { canTransition, schedule, type SchedTask } from "./scheduler.ts";
import { quotaCheck, estimateBuild } from "./quota.ts";
import { defaultSettings } from "./config.ts";
import { parseStreamLine, parseResetTime } from "./stream.ts";

const t = (id: string, o: Partial<SchedTask> = {}): SchedTask => ({
  id,
  kind: "build",
  role: "backend",
  status: "todo",
  after: [],
  owns: [`backend/${id}/**`],
  running: false,
  ...o,
});

describe("schedule", () => {
  const base = { runningByRole: {}, roleCaps: { backend: 2, frontend: 2, reviewer: 1, qa: 1, "tech-lead": 1, devops: 1 }, globalCap: 3, quotaOk: true, paused: false };

  it("promotes tasks whose deps are done and starts within caps", () => {
    const tasks = [t("T000", { status: "done" }), t("T001", { after: ["T000"] }), t("T002", { after: ["T000"] }), t("T003", { after: ["T000"] }), t("T004", { after: ["T001"] })];
    const a = schedule({ ...base, tasks });
    expect(a.filter((x) => x.type === "promote").map((x) => x.task)).toEqual(["T001", "T002", "T003"]);
    expect(a.filter((x) => x.type === "start").map((x) => x.task)).toEqual(["T001", "T002"]); // backend cap 2
  });

  it("respects the global cap and prefers review/qa over new work", () => {
    const tasks = [
      t("T001", { status: "ready" }),
      t("T002", { status: "review" }),
      t("T003", { status: "qa" }),
      t("T004", { status: "ready", role: "frontend", owns: ["frontend/**"] }),
    ];
    const a = schedule({ ...base, globalCap: 2, tasks }).filter((x) => x.type === "start");
    expect(a).toEqual([
      { type: "start", task: "T003", role: "qa", stage: "verify" },
      { type: "start", task: "T002", role: "reviewer", stage: "review" },
    ]);
  });

  it("does not start when paused or out of quota, but still promotes", () => {
    const tasks = [t("T001")];
    expect(schedule({ ...base, paused: true, tasks })).toEqual([{ type: "promote", task: "T001" }]);
    expect(schedule({ ...base, quotaOk: false, tasks: [t("T001")] })).toEqual([{ type: "promote", task: "T001" }]);
  });

  it("never starts two tasks with overlapping owns at once", () => {
    const tasks = [t("T001", { status: "in_progress", running: true, owns: ["backend/app/**"] }), t("T002", { status: "ready", owns: ["backend/app/api/x.py"] })];
    expect(schedule({ ...base, runningByRole: { backend: 1 }, tasks }).filter((x) => x.type === "start")).toEqual([]);
  });

  it("skips held tasks", () => {
    expect(schedule({ ...base, tasks: [t("T001", { status: "ready", hold: true })] })).toEqual([]);
  });
});

describe("transitions", () => {
  it("allows the board flow and forbids leaving done", () => {
    expect(canTransition("ready", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "review")).toBe(true);
    expect(canTransition("review", "qa")).toBe(true);
    expect(canTransition("qa", "done")).toBe(true);
    expect(canTransition("done", "in_progress")).toBe(false);
    expect(canTransition("todo", "review")).toBe(false);
  });
});

describe("authorize", () => {
  const be: Identity = { kind: "agent", agent: "backend-1", role: "backend", task: "T012", runId: "r1" };
  it.each([
    ["task.own on own task", be, "task.own", { task: "T012" }, true],
    ["task.own on other task", be, "task.own", { task: "T013" }, false],
    ["backend review", be, "review", {}, false],
    ["backend plan submit", be, "plan.submit", {}, false],
    ["backend doc submit prd", be, "doc.submit", { doc: "prd" }, false],
    ["human anything", { kind: "human" }, "plan.submit", {}, true],
  ] as const)("%s", (_n, id, action, c, ok) => {
    expect(authorize(id as Identity, action, c).ok).toBe(ok);
  });
  it("lets the right roles in", () => {
    const tl: Identity = { kind: "agent", agent: "tech-lead-1", role: "tech-lead", task: null, runId: "r" };
    expect(authorize(tl, "plan.submit").ok).toBe(true);
    expect(authorize(tl, "doc.submit", { doc: "contracts/openapi.yaml" }).ok).toBe(true);
    const ds: Identity = { kind: "agent", agent: "designer-1", role: "designer", task: null, runId: "r" };
    expect(authorize(ds, "doc.submit", { doc: "contracts/design-tokens.json" }).ok).toBe(true);
    expect(authorize(ds, "doc.submit", { doc: "contracts/openapi.yaml" }).ok).toBe(false);
    expect(authorize(ds, "review").ok).toBe(true);
    const qa: Identity = { kind: "agent", agent: "qa-1", role: "qa", task: "T1", runId: "r" };
    expect(authorize(qa, "qa").ok).toBe(true);
    expect(authorize(qa, "bug.create").ok).toBe(true);
  });
});

describe("quota", () => {
  it("allows up to (100 - reserve)% of the budget", () => {
    const s = { ...defaultSettings(), daily_token_budget: 1000, reserve_percent: 20 };
    expect(quotaCheck(s, { usedToday: 799 }).ok).toBe(true);
    expect(quotaCheck(s, { usedToday: 800 }).ok).toBe(false);
  });
  it("blocks while a usage limit is active", () => {
    const s = defaultSettings();
    expect(quotaCheck(s, { usedToday: 0, limitedUntil: Date.now() + 60_000 }).ok).toBe(false);
    expect(quotaCheck(s, { usedToday: 0, limitedUntil: Date.now() - 1 }).ok).toBe(true);
  });
  it("estimates build cost including review and QA runs", () => {
    const e = estimateBuild({ backend: 2 }, { backend: 100, reviewer: 10, qa: 20 });
    expect(e.totalTokens).toBe(2 * 100 + 2 * 10 + 2 * 20);
  });
});

describe("stream parsing", () => {
  it("parses init, tool_use, and result", () => {
    expect(parseStreamLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m" }))).toEqual([
      { kind: "init", sessionId: "s1", model: "m", tools: undefined },
    ]);
    const tool = parseStreamLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "backend/app/api/orders.py" } }] } }),
    );
    expect(tool[0]).toMatchObject({ kind: "tool", summary: "Editing `backend/app/api/orders.py`", file: "backend/app/api/orders.py" });
    const res = parseStreamLine(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 7, total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 5 }, result: "done" }),
    );
    expect(res[0]).toMatchObject({ kind: "result", turns: 7, costUsd: 0.12, isError: false, usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it("detects usage limits and reset times", () => {
    const res = parseStreamLine(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude AI usage limit reached|1900000000" }));
    expect(res[0]).toMatchObject({ kind: "result", usageLimit: { resetsAt: 1900000000000 } });
    const now = new Date(2026, 0, 1, 10, 0, 0);
    expect(new Date(parseResetTime("You've hit your session limit · resets 3:45pm", now)!).getHours()).toBe(15);
  });

  it("ignores non-JSON lines", () => {
    expect(parseStreamLine("hello")).toEqual([]);
  });
});
