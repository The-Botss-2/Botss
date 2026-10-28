import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, DEFAULT_BUILD_SCENARIO, events, startHarness, taskFile, waitFor, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

const batch = (intro: string, q: string) =>
  JSON.stringify({
    intro,
    questions: [
      {
        id: "Q1",
        topic: "Users",
        question: q,
        options: [
          { key: "A", label: "Only you" },
          { key: "B", label: "Your staff" },
        ],
        recommended: "A",
        why_it_matters: "Decides whether we need roles.",
      },
    ],
  });

const PLAN: Record<string, string> = {
  "T000.md": taskFile("T000", { role: "tech-lead", title: "App scaffold" }),
  "T001.md": taskFile("T001", { role: "devops", after: ["T000"], title: "Infra scaffold" }),
  "T002.md": taskFile("T002", { role: "backend", after: ["T001"], title: "Todo API" }),
  "T003.md": taskFile("T003", { role: "frontend", after: ["T001"], title: "Todo list screen" }),
  "T004.md": taskFile("T004", { role: "backend", after: ["T002"], title: "Todo completion API" }),
  "T005.md": taskFile("T005", { role: "frontend", after: ["T003"], title: "Completion UI" }),
};

const SCENARIO = {
  ...DEFAULT_BUILD_SCENARIO,
  "pm:discover": {
    steps: [
      { botss: ["whoami"] },
      { write: ".botss/docs/discovery/questions.json", content: batch("One decision before the PRD.", "Who uses the app?") },
      { botss: ["ask", "@human", "--batch", ".botss/docs/discovery/questions.json"] },
    ],
  },
  "pm:draft:resume": {
    steps: [
      { expectPrompt: "Q1" },
      { write: ".botss/docs/prd.md", content: "# PRD: Todo\n\n## FR\n- FR-1 add todos\n- FR-2 complete todos\n" },
      { botss: ["doc", "submit", "prd"] },
    ],
  },
  "designer:direction": {
    steps: [
      { write: ".botss/docs/design/directions/A.html", content: "<!doctype html><h1>Direction A</h1>" },
      { write: ".botss/docs/design/directions/B.html", content: "<!doctype html><h1>Direction B</h1>" },
      { write: ".botss/docs/design/directions.json", content: batch("Pick a direction.", "Which visual direction?") },
      { botss: ["ask", "@human", "--batch", ".botss/docs/design/directions.json"] },
    ],
  },
  "designer:system:resume": {
    steps: [
      { write: ".botss/docs/contracts/design-tokens.json", content: '{"color":{"bg":"#fafaf7","ink":"#111"}}' },
      { write: ".botss/docs/design/DESIGN.md", content: "# Design\n\nCalm paper." },
    ],
  },
  "designer:screens:resume": {
    steps: [
      { write: ".botss/docs/design/screens/home.html", content: "<!doctype html><h1>Todos</h1>" },
      { botss: ["doc", "submit", "design"] },
    ],
  },
  "tech-lead:architect": {
    steps: [
      { write: ".botss/docs/architecture.md", content: "# Architecture\n\nAD-1: one table.\n" },
      { write: ".botss/docs/contracts/openapi.yaml", content: "openapi: 3.1.0\ninfo: {title: Todo, version: '1'}\npaths: {}\n" },
      { botss: ["doc", "submit", "architecture"] },
    ],
  },
  "tech-lead:plan": {
    steps: [
      ...Object.entries(PLAN).map(([f, c]) => ({ write: `.botss/tasks/${f}`, content: c })),
      { write: ".botss/docs/plan-summary.md", content: "# Plan summary\n\nTeam: 1 backend, 1 frontend. Two lanes.\n" },
      { botss: ["plan", "check", ".botss/tasks/"] },
      { botss: ["plan", "submit", ".botss/tasks/"] },
    ],
  },
};

describe("1. happy path through every phase (fake claude)", () => {
  it("idea → PRD → design → architecture → plan → 6 tasks in 2 lanes → release → done", async () => {
    h = await startHarness(SCENARIO);
    const svc = h.project.svc;
    const phase = (p: string) => () => svc.phase === p;

    await h.api("POST", "/idea", { text: "A todo app for me and my family", stakes: "hobby", links: [], track: "full" });
    expect(svc.phase).toBe("discovery");

    const q1 = await waitFor(() => svc.questions("open").find((q) => q.kind === "batch"), "discovery batch");
    expect(q1.batch.questions[0].id).toBe("Q1");
    await h.api("POST", `/questions/${q1.id}/answer`, { answer: { answers: { Q1: "A" }, acceptedRecommendations: true } });

    await waitFor(phase("prd_review"), "PRD submitted");
    expect(svc.doc("prd")!.content).toContain("FR-1");
    await h.api("POST", "/gates/prd/approve", { comment: "Good" });
    expect(svc.phase).toBe("design_direction");

    const q2 = await waitFor(() => svc.questions("open").find((q) => q.kind === "batch"), "design directions");
    // The owner sees a preview of each direction before choosing.
    expect((await h.api("GET", "/design")).directionPreviews).toEqual(["A.html", "B.html"]);
    await h.api("POST", `/questions/${q2.id}/answer`, { answer: { answers: { Q1: "B" } } });
    // Screens are submitted for review; nothing moves on until the owner approves the design.
    await waitFor(() => svc.doc("design")?.status === "submitted", "design submitted");
    await new Promise((r) => setTimeout(r, 500));
    expect(svc.phase).toBe("design");
    const design = await h.api("GET", "/design");
    expect(design.screens).toEqual(["screens/home.html"]);
    expect(design.tokens.color.bg).toBe("#fafaf7");
    await h.api("POST", "/gates/design/approve", {});
    expect(svc.phase).toBe("architecture_review");

    await waitFor(() => svc.doc("architecture")?.status === "submitted", "architecture submitted");
    await h.api("POST", "/gates/architecture/approve", {});
    expect(svc.phase).toBe("plan_review");

    await waitFor(() => svc.doc("plan")?.status === "submitted", "plan submitted");
    const plan = await h.api("GET", "/plan");
    expect(plan.stats.peakLanes).toBe(2);
    expect(plan.stats.criticalPath).toEqual(["T000", "T001", "T002", "T004"]);
    expect(plan.estimate.totalTokens).toBeGreaterThan(0);
    // Build tasks wait for plan approval.
    await new Promise((r) => setTimeout(r, 500));
    expect(svc.tasks({ kind: ["build"] }).every((t) => t.status === "todo")).toBe(true);
    await h.api("POST", "/gates/plan/approve", { team: { backend: 1, frontend: 1 } });
    expect(svc.phase).toBe("build");

    await waitFor(() => svc.doc("release")?.status === "submitted", "release summary", 150_000);
    expect(svc.phase).toBe("release_review");
    await h.api("POST", "/gates/release/approve", {});
    expect(svc.phase).toBe("done");

    const build = svc.tasks({ kind: ["build"] });
    expect(build.map((t) => `${t.id}:${t.status}`)).toEqual(["T000:done", "T001:done", "T002:done", "T003:done", "T004:done", "T005:done"]);
    expect(svc.task("REL-QA")!.status).toBe("done");
    for (const t of build) expect(fs.existsSync(path.join(h.project.paths.integration, `src/${t.id}.txt`))).toBe(true);
    // Every merge ran the integration checks (captured from the T000 handoff) and passed.
    expect(svc.settings.checks.length).toBeGreaterThan(0);
    expect(events(h, "checks.failed")).toHaveLength(0);
    expect(events(h, "merge.ok").length).toBeGreaterThanOrEqual(7);
    // The two lanes really ran in parallel.
    const impl = (id: string) => svc.runs({ task: id }).find((r) => r.stage === "implement")!;
    const overlap = (a: any, b: any) => a.started_at < b.ended_at && b.started_at < a.ended_at;
    expect(overlap(impl("T002"), impl("T003")) || overlap(impl("T004"), impl("T005"))).toBe(true);
    // Gates were recorded.
    expect(h.project.db.all("SELECT gate, decision FROM approvals ORDER BY id").map((r) => `${r.gate}:${r.decision}`)).toEqual([
      "prd:approved",
      "design_direction:approved",
      "design:approved",
      "architecture:approved",
      "plan:approved",
      "release:approved",
    ]);
    expect(svc.settings.team).toMatchObject({ backend: 1, frontend: 1 });
    // Planning output was committed on the integration branch.
    expect(fs.existsSync(path.join(h.project.paths.integration, ".botss/tasks/T003.md"))).toBe(true);
  }, 240_000);
});
