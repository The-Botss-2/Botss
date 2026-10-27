import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, events, qaPass, reviewApprove, seedBuild, startHarness, taskFile, waitFor, type Harness } from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

/** Direct mode: edit files in place, no git. */
const work = (extra: Record<string, unknown>[] = []) => [
  { botss: ["task", "start", "${BOTSS_TASK}"] },
  {
    todo: [
      { content: "Read the task", status: "completed" },
      { content: "Write the file", status: "in_progress", activeForm: "Writing the file" },
      { content: "Hand off", status: "pending" },
    ],
  },
  { write: "src/${BOTSS_TASK}.txt", content: "work of ${BOTSS_TASK}\n" },
  { append: "README.md", content: "" },
  ...extra,
  { bash: "test -f src/${BOTSS_TASK}.txt" },
  { write: ".botss/handoffs/${BOTSS_TASK}.md", content: "# Handoff ${BOTSS_TASK}\n\n## What changed\nAdded the file.\n" },
  { botss: ["task", "done", "${BOTSS_TASK}", "--status", "DONE", "--handoff", ".botss/handoffs/${BOTSS_TASK}.md"] },
];

const SCENARIO = {
  "backend:implement": { steps: work([{ bash: 'git add -A && git commit -m "sneaky"', allowFail: true }]) },
  "frontend:implement": { steps: work() },
  "reviewer:review": { steps: reviewApprove },
  "qa:verify": { steps: qaPass },
  "qa:release": { steps: qaPass },
};

describe("direct workspace mode (no git, fake claude)", () => {
  it("agents work in the project folder in parallel; reviews see snapshot diffs; the owner is notified", async () => {
    h = await startHarness(SCENARIO, { workspace: "direct" });
    const svc = h.project.svc;
    expect(h.project.direct).toBe(true);
    // Only one hidden folder was added; no git, no worktrees, no copied skills.
    expect(fs.existsSync(path.join(h.root, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, ".botss", "skills"))).toBe(false);
    expect(fs.readdirSync(h.root).sort()).toEqual([".botss", "README.md", "src"]);

    await seedBuild(h, {
      "T001.md": taskFile("T001", { role: "backend", owns: ["src/T001.txt"] }),
      "T002.md": taskFile("T002", { role: "frontend", owns: ["src/T002.txt"] }),
    });
    await waitFor(() => svc.task("T001")?.status === "done" && svc.task("T002")?.status === "done", "both tasks done", 120_000);

    // The work landed directly in the chosen folder.
    expect(fs.readFileSync(path.join(h.root, "src/T001.txt"), "utf8")).toBe("work of T001\n");
    expect(fs.readFileSync(path.join(h.root, "src/T002.txt"), "utf8")).toBe("work of T002\n");
    expect(fs.existsSync(path.join(path.dirname(h.root), ".botss-worktrees"))).toBe(false);
    expect(fs.existsSync(path.join(h.root, ".git"))).toBe(false);
    // Every run worked in the project folder.
    expect(new Set(svc.runs({ limit: 50 }).map((r) => path.resolve(String(r.cwd))))).toEqual(new Set([path.resolve(h.root)]));
    // The guard stopped the agent from using git.
    expect(events(h, "guard.blocked").some((e) => /git add is not used in this project/.test(e.summary))).toBe(true);
    // The two lanes ran at the same time.
    const impl = (id: string) => svc.runs({ task: id }).find((r) => r.stage === "implement")!;
    const a = impl("T001");
    const b = impl("T002");
    expect(a.started_at < b.ended_at && b.started_at < a.ended_at).toBe(true);

    // What changed comes from the snapshot taken at the task's first run.
    const diff = await h.api("GET", "/tasks/T001/diff");
    expect(diff.files).toEqual([{ path: "src/T001.txt", status: "added" }]);
    expect(diff.diff).toContain("+work of T001");

    // Live progress: the agent's plan and plain-language activity are stored.
    expect(JSON.parse(String(a.todos))).toHaveLength(3);
    const labels = events(h, "run.tool").map((e) => e.data.label);
    expect(labels).toEqual(expect.arrayContaining(["Writing T001.txt", "Handing off the finished task"]));

    // The owner was notified about finished tasks.
    const notes = await h.api("GET", "/notifications");
    const titles = notes.map((n: any) => n.data.notify.title);
    expect(titles).toEqual(expect.arrayContaining(["T001 is done", "T002 is done", "The build has started"]));
  }, 180_000);
});
