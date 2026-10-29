import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, reviewApprove, seedBuild, startHarness, taskFile, waitFor, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

const work = (extra: Record<string, unknown>[] = [], file = "src/${BOTSS_TASK}.txt") => [
  { botss: ["task", "start", "${BOTSS_TASK}"] },
  ...extra,
  { write: file, content: "x\n" },
  { write: ".botss/handoffs/${BOTSS_TASK}.md", content: "# Handoff\n" },
  { botss: ["task", "done", "${BOTSS_TASK}", "--status", "DONE", "--handoff", ".botss/handoffs/${BOTSS_TASK}.md"] },
];

describe("learning memory and the needs-you inbox (fake claude, direct mode)", () => {
  it("a lesson recorded by one agent reaches later runs on matching files only", async () => {
    h = await startHarness(
      {
        "task:T001:implement": { steps: work([{ botss: ["lesson", "Use the shared Dialog, never window.confirm", "--paths", "src/**", "--roles", "frontend"] }]) },
        "frontend:implement": { steps: work() },
        "backend:implement": { steps: work([], "api/${BOTSS_TASK}.txt") },
        "reviewer:review": { steps: reviewApprove },
      },
      { workspace: "direct", settings: { qa_per_task: false } },
    );
    await seedBuild(h, {
      "T001.md": taskFile("T001", { role: "frontend", owns: ["src/T001.txt"] }),
      "T002.md": taskFile("T002", { role: "frontend", after: ["T001"], owns: ["src/T002.txt"] }),
      "T003.md": taskFile("T003", { role: "backend", after: ["T001"], owns: ["api/T003.txt"], verify: "test -f api/T003.txt" }),
    });
    const svc = h.project.svc;
    await waitFor(() => ["T002", "T003"].every((id) => svc.task(id)?.status === "done"), "tasks done", 120_000);

    expect(svc.lessons()).toMatchObject([{ text: "Use the shared Dialog, never window.confirm", roles: ["frontend"], paths: ["src/**"] }]);
    expect(fs.readFileSync(path.join(h.root, ".botss", "memory.md"), "utf8")).toContain("never window.confirm");
    const prompt = (task: string) => h!.invocations().find((i) => i.task === task && i.role !== "reviewer")!.prompt as string;
    // T002 is frontend work in src/: it gets the lesson. T003 is backend work elsewhere: it does not.
    expect(prompt("T002")).toContain("## Lessons from this project");
    expect(prompt("T002")).toContain("never window.confirm");
    expect(prompt("T003")).not.toContain("never window.confirm");
    // Per-task QA was off: engineer then reviewer only.
    expect(svc.runs({ task: "T002" }).map((r) => r.stage)).toEqual(["implement", "review"]);

    // The owner manages the memory from the dashboard API.
    const added = await h.api("POST", "/lessons", { text: "Keep API errors in the {error: {code, message}} shape", paths: ["api/**"] });
    await h.api("PATCH", `/lessons/${added.id}`, { pinned: true });
    expect((await h.api("GET", "/lessons"))[0]).toMatchObject({ id: added.id, pinned: true });
    await h.api("DELETE", `/lessons/${added.id}`);
    expect(await h.api("GET", "/lessons")).toHaveLength(1);
  }, 180_000);

  it("needs-you gathers questions, blocked tasks, and alerts in one list", async () => {
    h = await startHarness(
      {
        "backend:implement": { steps: [{ botss: ["task", "start", "${BOTSS_TASK}"] }, { botss: ["ask", "@human", "Which payment provider?"] }] },
        "frontend:implement": { steps: [{ botss: ["task", "start", "${BOTSS_TASK}"] }, { botss: ["task", "block", "${BOTSS_TASK}", "--on", "@designer", "--reason", "No spec for the empty state"] }] },
        "designer:answer": { steps: [{ text: "thinking" }] },
      },
      { workspace: "direct" },
    );
    await seedBuild(h, {
      "T001.md": taskFile("T001", { role: "backend", owns: ["api/**"] }),
      "T002.md": taskFile("T002", { role: "frontend", owns: ["web/**"] }),
    });
    h.project.svc.alert("Something to look at");
    const items = await waitFor(async () => {
      const list = await h!.api("GET", "/needs-you");
      return list.some((i: any) => i.kind === "question") && list.some((i: any) => i.kind === "blocked") ? list : null;
    }, "needs-you items", 60_000);
    expect(items.find((i: any) => i.kind === "question")).toMatchObject({ title: "backend-1 asks you", screen: "questions" });
    expect(items.find((i: any) => i.kind === "blocked")).toMatchObject({ task: "T002", action: "unblock" });
    expect(items.find((i: any) => i.kind === "alert")).toMatchObject({ title: "Something to look at", action: "dismiss" });
    // Questions come before blocked tasks and alerts.
    expect(items.map((i: any) => i.kind).indexOf("question")).toBeLessThan(items.map((i: any) => i.kind).indexOf("alert"));
  }, 120_000);
});
