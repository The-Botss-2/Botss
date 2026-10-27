import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  DEFAULT_BUILD_SCENARIO,
  events,
  implementSteps,
  qaPass,
  REPO,
  reviewApprove,
  seedBuild,
  startHarness,
  taskFile,
  waitFor,
  type Harness,
} from "../helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

const done = (id: string) => () => h!.project.svc.task(id)?.status === "done";

describe("pipeline (fake claude)", () => {
  it("2. review loop: changes requested once, then approved", async () => {
    h = await startHarness({
      ...DEFAULT_BUILD_SCENARIO,
      "reviewer:review": [
        {
          steps: [
            { botss: ["review", "start", "${BOTSS_TASK}"] },
            { botss: ["review", "comment", "${BOTSS_TASK}", "--file", "src/T001.txt", "--line", "1", "--severity", "major", "Say fixed, not work"] },
            { write: ".botss/reviews/${BOTSS_TASK}.md", content: "# Review\n\nOne major issue.\n" },
            { botss: ["review", "request-changes", "${BOTSS_TASK}", "--summary", "1 major issue", "--file", ".botss/reviews/${BOTSS_TASK}.md"] },
          ],
        },
        { steps: reviewApprove },
      ],
      "backend:implement:resume": { steps: [{ expectPrompt: "Say fixed, not work" }, ...implementSteps("src/T001.txt", "fixed T001\n")] },
    });
    await seedBuild(h, { "T001.md": taskFile("T001", { role: "backend" }) });
    await waitFor(done("T001"), "T001 done");
    const svc = h.project.svc;
    const reviews = svc.reviews("T001");
    expect(reviews.map((r) => r.verdict)).toEqual(["changes_requested", "approved"]);
    expect(reviews[0]!.comments[0]).toMatchObject({ file: "src/T001.txt", line: 1, severity: "major" });
    expect(svc.task("T001")!.review_round).toBe(1);
    // The engineer was resumed on the same session with the comments.
    const be = h.invocations().filter((i) => i.role === "backend");
    expect(be).toHaveLength(2);
    expect(be[1].resume).toBe(be[0].sessionId);
    expect(fs.readFileSync(path.join(h.project.paths.integration, "src/T001.txt"), "utf8")).toBe("fixed T001\n");
    const statuses = events(h, "task.status").filter((e) => e.task === "T001").map((e) => e.data.to);
    expect(statuses).toEqual(["ready", "in_progress", "review", "changes_requested", "in_progress", "review", "qa", "done"]);
  });

  it("3. QA fail creates a bug that is fixed in the next round", async () => {
    h = await startHarness({
      ...DEFAULT_BUILD_SCENARIO,
      "qa:verify": [
        {
          steps: [
            { write: ".botss/reviews/${BOTSS_TASK}-bug-1.md", content: "Steps: open the page. Expected: fixed text. Actual: work text." },
            { botss: ["bug", "create", "--task", "${BOTSS_TASK}", "--severity", "major", "--title", "Wrong text", "--file", ".botss/reviews/${BOTSS_TASK}-bug-1.md"] },
            { write: ".botss/reviews/${BOTSS_TASK}-qa.md", content: "# QA failed\n\nB-0001\n" },
            { botss: ["qa", "fail", "${BOTSS_TASK}", "--report", ".botss/reviews/${BOTSS_TASK}-qa.md"] },
          ],
        },
        { steps: qaPass },
      ],
      "backend:implement:resume": { steps: [{ expectPrompt: "Wrong text" }, ...implementSteps("src/T001.txt", "fixed T001\n")] },
    });
    await seedBuild(h, { "T001.md": taskFile("T001", { role: "backend" }) });
    await waitFor(done("T001"), "T001 done");
    const svc = h.project.svc;
    const bugs = svc.bugs("T001");
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ id: "B-0001", severity: "major", title: "Wrong text", status: "fixed" });
    expect(svc.qaReports("T001").map((r) => r.verdict)).toEqual(["fail", "pass"]);
    expect(svc.task("T001")!.qa_round).toBe(1);
    // After the fix it went through review again before QA.
    expect(svc.runs({ task: "T001" }).map((r) => r.stage)).toEqual(["implement", "review", "verify", "implement", "review", "verify"]);
  });

  it("4. a forced merge conflict creates an integrate task for the tech lead", async () => {
    const shared = (text: string) => [
      { botss: ["task", "start", "${BOTSS_TASK}"] },
      { write: "shared.txt", content: text },
      { write: "src/${BOTSS_TASK}.txt", content: "x" },
      { bash: 'git add -A && git commit -q -m "${BOTSS_TASK}"' },
      { write: ".botss/handoffs/${BOTSS_TASK}.md", content: "# Handoff ${BOTSS_TASK}" },
      { sleep: 300 },
      { botss: ["task", "done", "${BOTSS_TASK}", "--status", "DONE", "--handoff", ".botss/handoffs/${BOTSS_TASK}.md"] },
    ];
    h = await startHarness({
      ...DEFAULT_BUILD_SCENARIO,
      "task:T001:implement": { steps: shared("one\n") },
      "task:T002:implement": { steps: [{ sleep: 1500 }, ...shared("two\n")] },
      "tech-lead:integrate": {
        steps: [
          { expectPrompt: "Branch to merge" },
          { botss: ["task", "start", "${BOTSS_TASK}"] },
          { bash: 'git merge --no-ff -m merge "${MERGE_BRANCH}" || true' },
          { write: "shared.txt", content: "one and two\n" },
          { bash: 'git add -A && git commit -q -m "resolve conflict"' },
          { write: ".botss/handoffs/${BOTSS_TASK}.md", content: "# Integrated" },
          { botss: ["task", "done", "${BOTSS_TASK}", "--status", "DONE", "--handoff", ".botss/handoffs/${BOTSS_TASK}.md"] },
        ],
      },
    });
    await seedBuild(h, {
      "T001.md": taskFile("T001", { role: "backend", owns: ["shared.txt", "src/T001.txt"] }),
      // Parallel to T001 (no `after`), and it touches T001's file through may_touch: a planning mistake.
      "T002.md": taskFile("T002", { role: "frontend", owns: ["src/T002.txt"], may_touch: ["shared.txt"] }),
    });
    await waitFor(() => events(h!, "merge.conflict").length > 0, "merge conflict");
    const svc = h.project.svc;
    const integ = svc.tasks({ kind: ["integrate"] });
    expect(integ).toHaveLength(1);
    expect(integ[0]).toMatchObject({ id: "I-001", role: "tech-lead", owns: ["shared.txt"] });
    expect(integ[0]!.body).toContain("Handoff of");
    await waitFor(() => done("T001")() && done("T002")() && done("I-001")(), "all merged");
    expect(fs.readFileSync(path.join(h.project.paths.integration, "shared.txt"), "utf8")).toBe("one and two\n");
  });

  it("5. ask @human blocks the task, the answer resumes the same session", async () => {
    h = await startHarness({
      ...DEFAULT_BUILD_SCENARIO,
      "backend:implement": {
        steps: [
          { botss: ["task", "start", "${BOTSS_TASK}"] },
          { botss: ["ask", "@human", "Stripe test keys are needed. Add STRIPE_SECRET_KEY to .env?"] },
        ],
      },
      "backend:implement:resume": { steps: [{ expectPrompt: "Yes, use the test key" }, ...implementSteps()] },
    });
    await seedBuild(h, { "T001.md": taskFile("T001", { role: "backend" }) });
    const q = await waitFor(() => h!.project.svc.questions("open")[0], "question");
    await waitFor(() => h!.project.svc.task("T001")?.status === "blocked", "blocked");
    expect(q).toMatchObject({ to_addr: "@human", task: "T001", from_agent: "backend-1" });
    // The question is visible through the API (dashboard inbox).
    const open = await h.api("GET", "/questions?status=open");
    expect(open).toHaveLength(1);
    await waitFor(() => h!.project.svc.runs({ task: "T001" })[0]?.ended_at, "first run ended");
    await h.api("POST", `/questions/${q.id}/answer`, { answer: "Yes, use the test key" });
    await waitFor(done("T001"), "T001 done");
    const be = h.invocations().filter((i) => i.role === "backend");
    expect(be[1].resume).toBe(be[0].sessionId);
    expect(be[1].argv).toContain("--resume");
    expect(h.project.svc.question(q.id)).toMatchObject({ status: "answered", answered_by: "human" });
  });

  it("6. the guard hook blocks a write outside owns and a git push --force", async () => {
    h = await startHarness({
      ...DEFAULT_BUILD_SCENARIO,
      "backend:implement": {
        steps: [
          { botss: ["task", "start", "${BOTSS_TASK}"] },
          { write: "frontend/src/app/page.tsx", content: "not mine" },
          { write: "../escape.txt", content: "outside the worktree" },
          { bash: "git push --force origin HEAD", allowFail: true },
          ...implementSteps().slice(2),
        ],
      },
    });
    await seedBuild(h, { "T001.md": taskFile("T001", { role: "backend" }) });
    await waitFor(done("T001"), "T001 done");
    const blocks = events(h, "guard.blocked");
    expect(blocks.map((b) => b.summary).join("\n")).toMatch(/frontend\/src\/app\/page\.tsx is not in this task's owned paths/);
    expect(blocks.map((b) => b.summary).join("\n")).toMatch(/outside your worktree/);
    expect(blocks.map((b) => b.summary).join("\n")).toMatch(/git push --force/);
    expect(blocks.every((b) => b.actor === "backend-1" && b.task === "T001")).toBe(true);
    const wt = path.join(h.project.paths.worktrees, "backend-1-T001");
    expect(fs.existsSync(path.join(h.project.paths.integration, "frontend/src/app/page.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(wt), "escape.txt"))).toBe(false);
  });

  it("7. a usage-limit error pauses the scheduler and resumes after the reset", async () => {
    h = await startHarness({
      ...DEFAULT_BUILD_SCENARIO,
      "backend:implement": [{ steps: [{ botss: ["task", "start", "${BOTSS_TASK}"] }, { usageLimit: { inSeconds: 3 } }] }, { steps: implementSteps() }],
      "backend:implement:resume": { steps: [{ expectPrompt: "usage limit" }, ...implementSteps()] },
    });
    await seedBuild(h, {
      "T001.md": taskFile("T001", { role: "backend" }),
      "T002.md": taskFile("T002", { role: "frontend", after: ["T001"] }),
    });
    const limit = await waitFor(() => events(h!, "quota.limit")[0], "usage limit");
    const until = limit.data.resetsAt as number;
    expect(until).toBeGreaterThan(Date.now() - 1000);
    expect(h.project.svc.state.limitedUntil).toBe(until);
    expect(h.project.orch.quota().ok).toBe(false);
    // Nothing starts while limited.
    const runsAtLimit = h.project.svc.runs({ limit: 100 }).length;
    await new Promise((r) => setTimeout(r, 800));
    if (Date.now() < until - 200) expect(h.project.svc.runs({ limit: 100 }).length).toBe(runsAtLimit);
    await waitFor(() => events(h!, "quota.resumed").length > 0, "auto resume", 20_000);
    await waitFor(done("T002"), "both tasks done", 60_000);
    const be = h.invocations().filter((i) => i.task === "T001" && i.role === "backend");
    expect(be[1].resume).toBe(be[0].sessionId);
  });

  it("8. kill switch: every process is gone within 2 seconds and state is consistent after restart", async () => {
    h = await startHarness({ ...DEFAULT_BUILD_SCENARIO, "backend:implement": { steps: [{ botss: ["task", "start", "${BOTSS_TASK}"] }, { hang: true }] } }, { settings: { max_concurrent_agents: 3 } });
    await seedBuild(h, {
      "T001.md": taskFile("T001", { role: "backend" }),
      "T002.md": taskFile("T002", { role: "backend" }),
    });
    await waitFor(() => h!.project.svc.tasks({ status: "in_progress" }).length === 2, "two agents working");
    const pids = h.project.svc.runs({ active: true }).map((r) => r.pid as number);
    expect(pids).toHaveLength(2);
    const t0 = Date.now();
    const r = await h.api("POST", "/control/kill", {});
    expect(r.killed).toBe(2);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(() => pids.every((p) => !alive(p)), "processes gone", 2000, 50);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(h.project.svc.runs({ active: true })).toHaveLength(0);
    expect(h.project.svc.state.paused).toBe(true);

    await h.restart();
    const svc = h.project.svc;
    expect(svc.runs({ active: true })).toHaveLength(0);
    expect(svc.runs({ task: "T001" }).every((x) => x.result_status === "killed")).toBe(true);
    expect(svc.state).toMatchObject({ paused: true, pauseReason: "kill switch" });
    for (const id of ["T001", "T002"]) {
      const t = svc.task(id)!;
      expect(t.status).toBe("in_progress");
      expect(t.meta.resume?.prompt).toMatch(/kill switch/);
    }
    expect(svc.agents().every((a) => a.current_run === null)).toBe(true);
    // Still paused after restart: nothing starts until the owner resumes.
    await new Promise((res) => setTimeout(res, 600));
    expect(svc.runs({ active: true })).toHaveLength(0);
  });

  it("9. a plan with an ownership collision and a cycle is rejected with the right messages", async () => {
    h = await startHarness(DEFAULT_BUILD_SCENARIO);
    const dir = path.join(h.dir, "tasks");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "T000.md"), taskFile("T000", { role: "tech-lead", owns: ["backend/app/main.py"] }));
    fs.writeFileSync(path.join(dir, "T001.md"), taskFile("T001", { role: "backend", after: ["T000"], owns: ["backend/app/**"] }));
    fs.writeFileSync(path.join(dir, "T002.md"), taskFile("T002", { role: "frontend", after: ["T000"], owns: ["backend/app/api/orders.py"] }));
    fs.writeFileSync(path.join(dir, "T003.md"), taskFile("T003", { role: "backend", after: ["T004"], owns: ["src/T003.txt"] }));
    fs.writeFileSync(path.join(dir, "T004.md"), taskFile("T004", { role: "backend", after: ["T003"], owns: ["src/T004.txt"] }));
    // Run the real CLI as the owner against the running server.
    const home = path.join(h.dir, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ url: h.server.url, token: h.server.tokens.master, pid: process.pid }));
    const cli = (args: string[]) =>
      spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(REPO, "packages/cli/src/main.ts"), ...args], {
        cwd: h!.root,
        env: { ...process.env, BOTSS_HOME: home, BOTSS_TOKEN: "", BOTSS_SERVER_URL: "" },
        encoding: "utf8",
      });
    const r = cli(["plan", "check", dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[collision\] T001 and T002 can run in parallel but both own overlapping paths: "backend\/app\/\*\*" and "backend\/app\/api\/orders\.py"/);
    expect(r.stderr).toMatch(/\[cycle\] dependency cycle: T00[34] -> T00[34] -> T00[34]/);
    // Submit refuses to import.
    const s = cli(["plan", "submit", dir]);
    expect(s.status).toBe(1);
    expect(s.stderr).toMatch(/Not imported/);
    expect(h.project.svc.tasks({ kind: ["build"] })).toHaveLength(0);
    // JSON output carries the structured problems with task IDs.
    const j = cli(["plan", "check", dir, "--json"]);
    const parsed = JSON.parse(j.stdout);
    expect(parsed.data.problems.map((p: any) => [p.code, p.tasks.sort().join(",")])).toEqual(expect.arrayContaining([["collision", "T001,T002"], ["cycle", "T003,T004"]]));
    // Only the tech lead may submit: an agent token for another role is refused with exit 3.
  });
});
