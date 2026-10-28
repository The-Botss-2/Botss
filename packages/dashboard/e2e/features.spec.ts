import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  cleanup,
  DEFAULT_BUILD_SCENARIO,
  dismissToasts,
  goto,
  implementSteps,
  openDashboard,
  seed,
  startHarness,
  status,
  taskFile,
  waitFor,
  type Harness,
} from "./harness.ts";

let h: Harness | undefined;
test.afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

test("folder picker: deep link, navigate, mkdir, go up, open new and existing folders", async ({ page }) => {
  h = await startHarness(DEFAULT_BUILD_SCENARIO);
  fs.mkdirSync(path.join(h.dir, "legacy-shop", "src"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "legacy-shop", "package.json"), "{}\n");
  await page.goto(`${h.server.url}/?token=${h.server.tokens.master}#/open?path=${encodeURIComponent(h.dir)}`);

  const picker = page.getByTestId("folder-picker");
  await expect(picker).toBeVisible();
  // The harness project shows up as a Botss project; the plain folder does not.
  await expect(picker.getByTestId("fs-entry-sample app")).toContainText("Botss project");
  await expect(picker.getByTestId("fs-entry-legacy-shop")).not.toContainText("Botss project");

  // New folder, then up again: it is listed.
  await picker.getByRole("button", { name: "+ New folder" }).click();
  await picker.getByLabel("New folder name").fill("fresh-app");
  await picker.getByRole("button", { name: "Create" }).click();
  await expect(picker.getByTestId("fs-breadcrumb")).toContainText("fresh-app");
  await expect(picker.getByTestId("fs-summary")).toContainText("fresh-app");
  await expect(picker.getByTestId("fs-existing")).not.toBeChecked();
  await picker.getByRole("button", { name: "Up one folder" }).click();
  await expect(picker.getByTestId("fs-entry-fresh-app")).toBeVisible();

  // A folder with code: "existing project" is pre-checked; open it and the Idea screen asks for a change.
  await picker.getByTestId("fs-entry-legacy-shop").click();
  await expect(picker.getByTestId("fs-existing")).toBeChecked();
  await picker.getByTestId("fs-open").click();
  await expect(page.getByTestId("project-name")).toHaveText("legacy-shop", { timeout: 60_000 });
  const legacyId = new URL(page.url()).hash.split("/")[2]!;
  expect(fs.existsSync(path.join(h.dir, "legacy-shop", ".botss"))).toBe(true);
  await page.evaluate((pid) => (window.location.hash = `#/p/${pid}/idea`), legacyId);
  await expect(page.getByRole("heading", { name: "What should the team change?" })).toBeVisible();
  await expect(page.getByTestId("existing-note")).toContainText("Documents → codebase");
  await expect(page.getByTestId("kind-feature")).toBeVisible();

  // Back to projects; open the empty folder as a new project.
  await page.evaluate(() => (window.location.hash = "#/"));
  await page.getByTestId("open-folder").click();
  await page.getByTestId("folder-picker").getByRole("button", { name: "Home" }).click();
  await page.goto(`${h.server.url}/#/open?path=${encodeURIComponent(path.join(h.dir, "fresh-app"))}`);
  await expect(page.getByTestId("fs-summary")).toContainText("fresh-app");
  await page.getByTestId("fs-open").click();
  await expect(page.getByTestId("project-name")).toHaveText("fresh-app", { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "What should the team build?" })).toBeVisible();
});

test("change request: PM updates the PRD, owner approves, tech lead replans, owner approves, new task builds", async ({
  page,
}) => {
  h = await startHarness({
    ...DEFAULT_BUILD_SCENARIO,
    "pm:change": {
      steps: [
        {
          write: ".botss/docs/prd.md",
          content:
            "# PRD\n\nBookings.\n\n## FR-9 SMS reminders\nSend a reminder the evening before.\n\n## Changelog\n- CR-001: reminders\n",
        },
        { botss: ["doc", "submit", "prd"] },
      ],
    },
    "tech-lead:replan": {
      steps: [
        {
          write: ".botss/tasks/T002.md",
          content: taskFile("T002", { role: "backend", title: "SMS reminders" }),
        },
        { botss: ["plan", "submit", ".botss/tasks/"] },
      ],
    },
  });
  const svc = h.project.svc;
  svc.submitDoc("prd", ".botss/docs/prd.md", "# PRD\n\nBookings.\n", "pm-1", "pm");
  svc.setDocStatus("prd", "approved", null);
  svc.recordApproval("prd", "prd", 1, "approved", null);
  await seed(h, { T001: { role: "backend", title: "Bookings API" } });
  await waitFor(() => status(h!, "T001") === "done", "T001 done", 150_000);

  await openDashboard(page, h, "questions");
  await page.getByTestId("request-change").click();
  const dlg = page.getByTestId("change-dialog");
  await expect(dlg).toContainText("work already merged is kept");
  await dlg.getByLabel("The change").fill("Send SMS reminders the evening before each booking.");
  await dlg.getByRole("button", { name: "Send change request" }).click();
  await expect(page.getByText(/CR-001 sent to the PM/)).toBeVisible();

  // PM updates the PRD → owner reviews it from the callout.
  const callout = page.getByTestId("change-callout");
  await expect(callout).toContainText("PRD needs your review", { timeout: 90_000 });
  await dismissToasts(page);
  await callout.getByRole("link", { name: /Review the updated PRD/ }).click();
  const gate = page.getByTestId("gate-bar");
  await expect(gate).toContainText("CR-001 updated the PRD");
  await gate.getByRole("button", { name: "Approve prd" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();

  // Tech lead replans → owner approves the updated plan.
  await expect(page.getByTestId("change-callout")).toContainText("Plan needs your review", {
    timeout: 90_000,
  });
  // Server race (reported): approving before the replan planning task has merged lets the new build task branch
  // too early, and its `task done` is refused. Wait for the merge, as an owner reading the plan would.
  await waitFor(
    () => svc.tasks({ kind: ["planning"] }).every((t) => t.status === "done"),
    "replan merged",
    60_000,
  );
  await dismissToasts(page);
  await page
    .getByTestId("change-callout")
    .getByRole("link", { name: /Review the updated plan/ })
    .click();
  await expect(page.getByTestId("gate-bar")).toContainText("CR-001 updated the plan");
  await page.getByTestId("gate-bar").getByRole("button", { name: "Approve plan" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("changes-list")).toContainText("Applied");
  await expect(page.getByTestId("change-callout")).toHaveCount(0);

  await waitFor(() => status(h!, "T002") === "done", "T002 done", 150_000);
  await goto(page, h, "board");
  await expect(page.getByTestId("col-done").getByTestId("card-T002")).toBeVisible();
});

test("design gate: request changes needs a comment, resubmission reopens it, approval moves to architecture", async ({
  page,
}) => {
  h = await startHarness(DEFAULT_BUILD_SCENARIO);
  const svc = h.project.svc;
  const screens = path.join(h.project.paths.integration, ".botss/docs/design/screens");
  fs.mkdirSync(screens, { recursive: true });
  fs.writeFileSync(path.join(screens, "home.html"), "<!doctype html><h1>Home</h1>");
  svc.setPhase("design");
  svc.submitDoc(
    "design",
    ".botss/docs/design/DESIGN.md",
    "# Design\n\nTokens and screens.\n",
    "designer-1",
    "designer",
  );
  // Nothing else should run during this test.
  h.project.orch.pause("test");

  await openDashboard(page, h, "design");
  const gate = page.getByTestId("gate-bar");
  await expect(gate).toContainText("Review the screens, then approve the design or ask for changes");
  await gate.getByRole("button", { name: "Request changes" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByRole("button", { name: "Send to author" })).toBeDisabled();
  await dlg.getByLabel(/What should change/).fill("Make the primary button larger on mobile.");
  await dlg.getByRole("button", { name: "Send to author" }).click();
  await expect(gate).toBeHidden();
  expect(svc.doc("design")?.status).toBe("changes_requested");
  expect(svc.tasks({ kind: ["planning"] }).some((t) => t.role === "designer" && t.mode === "screens")).toBe(
    true,
  );

  // The designer resubmits: the gate opens again (also on Documents → design).
  svc.submitDoc(
    "design",
    ".botss/docs/design/DESIGN.md",
    "# Design\n\nBigger buttons.\n",
    "designer-1",
    "designer",
  );
  await goto(page, h, "docs/design");
  await expect(page.getByTestId("gate-bar")).toContainText("Review the screens");
  await goto(page, h, "design");
  await page.getByTestId("gate-bar").getByRole("button", { name: "Approve design" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await waitFor(() => svc.phase === "architecture_review", "architecture phase");
  await expect(page.getByTestId("phase-stepper").locator('[aria-current="step"]')).toContainText(
    "Architecture",
  );
});

test("live agents: the panel streams text, tool calls with inline content, and the drawer Live tab shows the run", async ({
  page,
}) => {
  h = await startHarness({
    ...DEFAULT_BUILD_SCENARIO,
    "backend:implement": {
      steps: [
        { botss: ["task", "start", "${BOTSS_TASK}"] },
        { text: "I'll add the slots endpoint first, then wire the tests." },
        {
          todo: [
            { content: "Read the slots contract", status: "completed" },
            {
              content: "Write the slots endpoint",
              status: "in_progress",
              activeForm: "Writing the slots endpoint",
            },
            { content: "Run the tests", status: "pending" },
          ],
        },
        { write: "src/${BOTSS_TASK}.txt", content: "slots endpoint\nline two\n" },
        { bash: "echo checking-the-build" },
        { hang: true },
      ],
    },
  });
  await openDashboard(page, h, "agents");
  await seed(h, { T001: { role: "backend", title: "Slots API" } });
  const panel = page.getByTestId("agent-backend-1");
  await expect(panel).toContainText("working", { timeout: 90_000 });
  // Visual card: plan checklist with progress, plain-language status, stage track, files.
  await expect(panel.getByTestId("plan-progress")).toHaveText("1 of 3 steps", { timeout: 30_000 });
  await expect(panel.getByTestId("plan-checklist").locator('[data-status="in_progress"]')).toContainText(
    "Writing the slots endpoint",
  );
  await expect(panel.getByTestId("agent-label")).not.toBeEmpty();
  await expect(panel.getByTestId("stage-track")).toContainText("Building");
  await expect(panel.getByTestId("files-touched")).toContainText("T001.txt");
  await expect(page.getByTestId("team-summary")).toContainText("1 agent working");
  await expect(panel.getByTestId("live-transcript")).toHaveCount(0);
  await panel.getByTestId("details-toggle").click();
  const live = panel.getByTestId("live-transcript");
  await expect(live.getByTestId("live-text")).toContainText("slots endpoint first", { timeout: 30_000 });
  await expect(live.locator('[data-tool="Write"]')).toContainText("src/T001.txt");
  await expect(live.locator('[data-tool="Write"]')).toContainText("line two");
  await expect(
    live.locator('[data-tool="Bash"]').filter({ hasText: "$ echo checking-the-build" }),
  ).toBeVisible();
  await expect(live.getByTestId("thinking")).toBeVisible();

  await goto(page, h, "board/T001");
  const drawer = page.getByTestId("task-drawer");
  await drawer.getByRole("tab", { name: /Live/ }).click();
  await expect(drawer.getByTestId("live-transcript").locator('[data-tool="Write"]')).toContainText(
    "src/T001.txt",
  );
});

test("notifications: ask @human toasts, bell counts, click goes to Questions; done toast; direct-mode diff", async ({
  page,
}) => {
  h = await startHarness(
    {
      ...DEFAULT_BUILD_SCENARIO,
      "backend:implement": {
        steps: [
          { botss: ["task", "start", "${BOTSS_TASK}"] },
          { botss: ["ask", "@human", "Which currency should prices use?"] },
        ],
      },
      "backend:implement:resume": { steps: [{ expectPrompt: "Euros" }, ...implementSteps()] },
    },
    { workspace: "direct" },
  );
  await openDashboard(page, h, "board");
  await expect(page.getByTestId("bell-count")).toHaveCount(0);
  await seed(h, { T001: { role: "backend", title: "Prices API" } });

  const toast = page.getByTestId("notify-toast").filter({ hasText: "asks you" });
  await expect(toast).toBeVisible({ timeout: 90_000 });
  await expect(toast).toHaveAttribute("data-level", "action");
  // Unread: "The build has started" (from seeding the build) and the question.
  await expect(page.getByTestId("bell-count")).toHaveText("2");
  await expect.poll(() => page.title()).toMatch(/^\(1\) Botss · /);
  await toast.click();
  await expect(page).toHaveURL(/#\/p\/[^/]+\/questions/);
  await expect(toast).toHaveCount(0);

  // Bell panel: "Needs you" lists the open question; mark all read clears the count.
  await page.getByTestId("bell").click();
  await expect(page.getByTestId("needs-you")).toContainText("asks you");
  await expect(page.getByTestId("needs-you").getByTestId("notify-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByTestId("bell-count")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await waitFor(() => h!.project.svc.runs({ task: "T001" })[0]?.ended_at, "first run ended");
  const card = page.locator('[data-testid^="question-Q-"]');
  await card.getByLabel("Your answer").fill("Euros");
  await card.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByTestId("notify-toast").filter({ hasText: "T001 is done" })).toBeVisible({
    timeout: 150_000,
  });
  await expect(page.getByTestId("notify-toast").filter({ hasText: "T001 is done" })).toHaveAttribute(
    "data-level",
    "success",
  );

  // Direct workspace: the Diff tab lists files changed since the task started; no branch row.
  await goto(page, h, "board/T001");
  const drawer = page.getByTestId("task-drawer");
  await expect(drawer.getByText("branch", { exact: true })).toHaveCount(0);
  await drawer.getByRole("tab", { name: /Diff/ }).click();
  await expect(drawer.getByTestId("task-diff")).toContainText("Changes since the task started");
  await expect(drawer.getByTestId("diff-files")).toContainText("src/T001.txt");
  await expect(drawer.getByTestId("diff-files")).toContainText("added");
});
