import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, DEFAULT_BUILD_SCENARIO, events, seedBuild, startHarness, taskFile, waitFor, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

describe("single task end to end (fake claude)", () => {
  it("implements, reviews, verifies, and merges one task", async () => {
    h = await startHarness(DEFAULT_BUILD_SCENARIO);
    await seedBuild(h, { "T000.md": taskFile("T000", { role: "tech-lead" }) });
    await waitFor(() => h!.project.svc.task("T000")?.status === "done", "T000 done");

    const svc = h.project.svc;
    // The task went through every stage, with the right agents.
    const runs = svc.runs({ task: "T000" });
    expect(runs.map((r) => `${r.agent}:${r.stage}:${r.result_status}`)).toEqual(["tech-lead-1:implement:success", "reviewer-1:review:success", "qa-1:verify:success"]);
    const statuses = events(h, "task.status").filter((e) => e.task === "T000").map((e) => e.data.to);
    expect(statuses).toEqual(["ready", "in_progress", "review", "qa", "done"]);
    // Merged into the integration branch, worktree cleaned up.
    expect(fs.readFileSync(path.join(h.project.paths.integration, "src/T000.txt"), "utf8")).toContain("work of T000");
    expect(events(h, "merge.ok")).toHaveLength(1);
    await waitFor(() => !fs.existsSync(path.join(h!.project.paths.worktrees, "tech-lead-1-T000")), "worktree cleanup", 10_000);
    // Handoff stored, checks captured from the T000 handoff.
    expect(svc.handoffs("T000")[0]!.content).toContain("## What changed");
    expect(svc.settings.checks).toEqual(["test -d .botss"]);
    // Live feed got tool events with human summaries.
    expect(events(h, "run.tool").some((e) => /Writing `.*src[\\/]T000\.txt`/.test(e.summary))).toBe(true);
    expect(events(h, "progress.note").map((e) => e.summary)).toContain("Finished T000");
    // Usage recorded from the result event.
    expect(runs[0]!.input_tokens).toBeGreaterThan(0);
    // The agent got the documented environment.
    const inv = h.invocations()[0];
    expect(inv).toMatchObject({ role: "tech-lead", task: "T000", mode: "scaffold", resume: null });
    expect(inv.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--session-id", "--append-system-prompt-file", "--settings", "--max-turns"]));
    const system = fs.readFileSync(path.join(h.project.paths.run(runs[0]!.id), "system.md"), "utf8");
    // The system prompt is the same for every run of a role (prompt caching); identity goes in the run prompt.
    expect(system).not.toContain("tech-lead-1");
    expect(fs.readFileSync(path.join(h.project.paths.run(runs[0]!.id), "prompt.md"), "utf8")).toContain("You are **tech-lead-1**");
    expect(system).toContain("<!-- skill: team-protocol -->");
    expect(system.indexOf("skill: team-protocol")).toBeLessThan(system.indexOf("skill: tech-lead"));
    expect(system).not.toContain("<!-- skill: ui-ux-designer -->");
  });
});
