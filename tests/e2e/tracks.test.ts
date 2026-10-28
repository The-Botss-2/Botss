import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, events, startHarness, taskFile, waitFor, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

const T1 = taskFile("T001", { role: "frontend", owns: ["src/T001.txt"], title: "Make the header blue" });
const T2 = taskFile("T002", { role: "frontend", owns: ["src/T002.txt"], title: "Rename the button" });

/** Direct-mode engineer run: edit, verify, hand off. */
const build = [
  { botss: ["task", "start", "${BOTSS_TASK}"] },
  { write: "src/${BOTSS_TASK}.txt", content: "done ${BOTSS_TASK}\n" },
  { write: ".botss/handoffs/${BOTSS_TASK}.md", content: "# Handoff ${BOTSS_TASK}\n" },
  { botss: ["task", "done", "${BOTSS_TASK}", "--status", "DONE", "--handoff", ".botss/handoffs/${BOTSS_TASK}.md"] },
];

const triage = (track: string, files: Record<string, string> = {}) => ({
  steps: [
    ...Object.entries(files).map(([f, c]) => ({ write: `.botss/tasks/${f}`, content: c })),
    ...(Object.keys(files).length ? [{ botss: ["plan", "submit", ".botss/tasks/"] }] : []),
    { write: ".botss/docs/triage.md", content: `track: ${track}\n\nUnderstood the request. Next: ${track}.\n` },
    { botss: ["doc", "submit", "triage"] },
  ],
});

describe("process tracks (fake claude, direct mode)", () => {
  it("quick: triage plans the task, it is built and finished with no PRD, design, review, or QA; the next request works the same way", async () => {
    h = await startHarness(
      {
        "tech-lead:triage": [triage("quick", { "T001.md": T1 }), triage("quick", { "T001.md": T1, "T002.md": T2 })],
        "frontend:implement": { steps: build },
      },
      { workspace: "direct" },
    );
    const svc = h.project.svc;
    await h.api("POST", "/idea", { text: "Make the header blue" });
    expect(svc.tasks({ kind: ["planning"] })[0]).toMatchObject({ role: "tech-lead", mode: "triage" });
    await waitFor(() => svc.phase === "done", "quick request done", 90_000);

    expect(svc.state.track).toBe("quick");
    expect(fs.readFileSync(path.join(h.root, "src/T001.txt"), "utf8")).toBe("done T001\n");
    // Only the tech lead (triage) and the engineer worked: no PM, designer, reviewer, or QA.
    expect([...new Set(svc.runs({ limit: 50 }).map((r) => r.role))].sort()).toEqual(["frontend", "tech-lead"]);
    expect(svc.doc("prd")).toBeNull();
    expect(svc.task("T001")).toMatchObject({ status: "done" });
    const titles = (await h.api("GET", "/notifications")).map((n: any) => n.data.notify.title);
    expect(titles).toEqual(expect.arrayContaining(["T001 is done", "All done"]));
    expect(titles.some((t: string) => /Process: quick/.test(t))).toBe(true);

    // The next request: straight from "done", same quick flow.
    await h.api("POST", "/idea", { text: "Rename the button" });
    await waitFor(() => svc.task("T002")?.status === "done" && svc.phase === "done", "second request done", 90_000);
    expect(fs.readFileSync(path.join(h.root, "src/T002.txt"), "utf8")).toBe("done T002\n");
  }, 200_000);

  it("standard: triage asks for a short PRD; after approval the plan comes next, without design or architecture", async () => {
    h = await startHarness(
      {
        "tech-lead:triage": triage("standard"),
        "pm:draft": {
          steps: [
            { expectPrompt: "Standard track" },
            { write: ".botss/docs/prd.md", content: "# PRD\n\n- FR-1 export to CSV\n" },
            { botss: ["doc", "submit", "prd"] },
          ],
        },
        "tech-lead:plan": { steps: [{ expectPrompt: "Standard track" }, { text: "planning" }] },
      },
      { workspace: "direct" },
    );
    const svc = h.project.svc;
    await h.api("POST", "/idea", { text: "Export the orders list to CSV" });
    await waitFor(() => svc.phase === "prd_review", "short PRD submitted", 60_000);
    expect(svc.state.track).toBe("standard");
    expect(svc.questions()).toHaveLength(0); // no discovery questions
    await h.api("POST", "/gates/prd/approve", {});
    expect(svc.phase).toBe("plan_review");
    expect(svc.tasks({ kind: ["planning"] }).map((t) => t.mode)).toEqual(["triage", "draft", "plan"]);
    expect(events(h, "task.created").some((e) => e.data.mode === "direction")).toBe(false);
  }, 120_000);

  it("the owner can pick a track, and cancel current work to start over", async () => {
    h = await startHarness({ "pm:discover": { steps: [{ sleep: 60_000 }] } }, { workspace: "direct" });
    const svc = h.project.svc;
    await h.api("POST", "/idea", { text: "A big new product", track: "full" });
    expect(svc.tasks({ kind: ["planning"] })[0]).toMatchObject({ role: "pm", mode: "discover" });
    await waitFor(() => svc.runs({ active: true }).length === 1, "PM working");
    // A second request while one is in flight is refused with a clear message.
    await expect(h.api("POST", "/idea", { text: "something else" })).rejects.toThrow(/still working on the current request/);
    await h.api("POST", "/cancel", {});
    expect(svc.phase).toBe("idea");
    expect(svc.runs({ active: true })).toHaveLength(0);
    expect(svc.state.paused).toBe(false);
    expect(svc.tasks().every((t) => t.status === "done")).toBe(true);
    // And a fresh request can be sent right away.
    await h.api("POST", "/idea", { text: "Just change the footer text", track: "quick" });
    expect(svc.tasks({ kind: ["planning"] }).at(-1)).toMatchObject({ mode: "triage" });
  }, 120_000);
});
