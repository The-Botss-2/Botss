import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, DEFAULT_BUILD_SCENARIO, events, seedBuild, startHarness, taskFile, waitFor, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

const done = (id: string) => () => h!.project.svc.task(id)?.status === "done";
const T1 = taskFile("T001", { role: "backend", title: "Todo API" });
const T2 = taskFile("T002", { role: "frontend", after: ["T001"], title: "Due dates on todos" });

/** Pretend the planning phases happened: an approved PRD on record. */
function approvedPrd(hh: Harness): void {
  hh.project.svc.submitDoc("prd", ".botss/docs/prd.md", "# PRD\n\n- FR-1 todos\n", "pm-1", "pm");
  hh.project.svc.setDocStatus("prd", "approved", null, "human");
  hh.project.svc.recordApproval("prd", "prd", 1, "approved", null);
}

describe("changes and existing projects (fake claude)", () => {
  it("a change request mid-build: PM updates the PRD, owner approves, tech lead replans, new tasks wait for approval", async () => {
    h = await startHarness({
      ...DEFAULT_BUILD_SCENARIO,
      "pm:change": {
        steps: [
          { expectPrompt: "Add due dates" },
          { write: ".botss/docs/prd.md", content: "# PRD\n\n- FR-1 todos\n- FR-2 due dates\n\n## Changelog\n- CR-001: added FR-2\n" },
          { bash: 'git add -A && git commit -q -m "CR-001 PRD"' },
          { botss: ["doc", "submit", "prd"] },
        ],
      },
      "tech-lead:replan": {
        steps: [
          { expectPrompt: "CR-001" },
          { write: ".botss/tasks/T001.md", content: T1 },
          { write: ".botss/tasks/T002.md", content: T2 },
          { bash: 'git add -A && git commit -q -m "CR-001 plan"' },
          { botss: ["plan", "submit", ".botss/tasks/"] },
        ],
      },
    });
    approvedPrd(h);
    await seedBuild(h, { "T001.md": T1 });
    await waitFor(done("T001"), "T001 done");
    const svc = h.project.svc;

    const cr = await h.api("POST", "/changes", { text: "Add due dates to todos." });
    expect(cr.id).toBe("CR-001");
    // Only one change at a time.
    await expect(h.api("POST", "/changes", { text: "Another one" })).rejects.toThrow(/CR-001 is still in progress/);

    await waitFor(() => h!.project.orch.activeChange()?.status === "prd_review", "PRD change submitted");
    expect(svc.doc("prd")!.content).toContain("FR-2 due dates");
    const summary = await h.api("GET", "");
    expect(summary.activeChange).toMatchObject({ id: "CR-001", status: "prd_review" });
    await h.api("POST", "/gates/prd/approve", {});

    await waitFor(() => h!.project.orch.activeChange()?.status === "plan_review", "replan submitted");
    // The new task exists but waits for the owner's approval of the updated plan.
    const t2 = svc.task("T002")!;
    expect(t2.hold).toBe("plan");
    await new Promise((r) => setTimeout(r, 600));
    expect(svc.runs({ task: "T002" })).toHaveLength(0);
    await h.api("POST", "/gates/plan/approve", {});

    await waitFor(done("T002"), "T002 done", 120_000);
    expect(h.project.orch.changes()[0]).toMatchObject({ id: "CR-001", status: "applied" });
    // Planning work during the build ran in its own worktree and was merged, not committed under the merge pipeline.
    const planning = svc.tasks({ kind: ["planning"] });
    expect(planning.map((t) => `${t.mode}:${t.status}`)).toEqual(["change:done", "replan:done"]);
    expect(fs.readFileSync(path.join(h.project.paths.integration, ".botss/docs/prd.md"), "utf8")).toContain("FR-2");
    expect(events(h, "merge.ok").map((e) => e.task)).toEqual(expect.arrayContaining(["T001", "P-001", "P-002", "T002"]));
  }, 240_000);

  it("an existing codebase is surveyed first; its checks are captured and discovery follows", async () => {
    h = await startHarness(
      {
        ...DEFAULT_BUILD_SCENARIO,
        "tech-lead:survey": {
          steps: [
            { expectPrompt: "existing codebase" },
            { write: ".botss/docs/codebase.md", content: "# Codebase\n\nA README.\n\n## Checks\n- `test -f README.md`\n" },
            { botss: ["doc", "submit", "codebase"] },
          ],
        },
        "pm:discover": { steps: [{ text: "discovering" }] },
      },
      { settings: { existing: true } },
    );
    await h.api("POST", "/idea", { text: "Add a dark mode toggle", kind: "feature" });
    const svc = h.project.svc;
    expect(svc.tasks({ kind: ["planning"] })[0]).toMatchObject({ role: "tech-lead", mode: "survey" });
    await waitFor(() => svc.tasks({ kind: ["planning"] }).some((t) => t.mode === "discover"), "discovery after survey");
    expect(svc.settings.checks).toEqual(["test -f README.md"]);
    expect(svc.doc("idea")!.content).toContain("existing codebase");
  });

  it("teammate questions to one role are batched into one answer task; long messages are refused", async () => {
    h = await startHarness(DEFAULT_BUILD_SCENARIO);
    h.project.orch.pause();
    await seedBuild(h, { "T001.md": taskFile("T001", { role: "backend" }), "T002.md": taskFile("T002", { role: "frontend" }) });
    const cmds = h.project.cmds;
    const be = { kind: "agent" as const, agent: "backend-1", role: "backend" as const, task: "T001", runId: "R-x" };
    const fe = { kind: "agent" as const, agent: "frontend-1", role: "frontend" as const, task: "T002", runId: "R-y" };
    cmds.ask(be, "@tech-lead", "Which error shape for 409?", null);
    cmds.ask(fe, "@tech-lead", "Is the list paginated?", null);
    const answers = h.project.svc.tasks({ kind: ["answer"] });
    expect(answers).toHaveLength(1);
    expect(answers[0]!.meta.answersList).toHaveLength(2);
    expect(answers[0]!.body).toContain("409");
    expect(answers[0]!.body).toContain("paginated");
    expect(() => cmds.msg(be, "@frontend", "x".repeat(2500))).toThrow(/limit is 2000/);
  });
});
