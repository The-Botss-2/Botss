import { expect, test } from "@playwright/test";
import {
  cleanup,
  DEFAULT_BUILD_SCENARIO,
  goto,
  implementSteps,
  openDashboard,
  seed,
  startHarness,
  status,
  waitFor,
  type Harness,
} from "./harness.ts";

let h: Harness | undefined;
test.afterEach(async () => {
  await cleanup(h);
  h = undefined;
});

test("opening the tokened link loads the project and strips the token", async ({ page }) => {
  h = await startHarness(DEFAULT_BUILD_SCENARIO);
  await openDashboard(page, h, "idea");
  await expect(page.getByTestId("project-name")).toHaveText("sample app");
  // Token moved into sessionStorage, out of the address bar.
  expect(page.url()).not.toContain("token=");
  expect(await page.evaluate(() => sessionStorage.getItem("botss.token"))).toBe(h.server.tokens.master);
  // Phase stepper shows the idea phase as current.
  await expect(page.getByTestId("phase-stepper").locator('[aria-current="step"]')).toContainText("Idea");
  await expect(page.getByRole("heading", { name: "What should the team build?" })).toBeVisible();
  // Survives a reload (token comes from sessionStorage now).
  await page.reload();
  await expect(page.getByTestId("project-name")).toHaveText("sample app");
});

test.describe("a seeded two-task build", () => {
  test("board moves both tasks to Done; drawer shows handoff and diff; feed shows merges", async ({
    page,
  }) => {
    h = await startHarness(DEFAULT_BUILD_SCENARIO);
    await openDashboard(page, h, "board");
    await expect(page.getByText("No tasks yet")).toBeVisible();

    await seed(h, {
      T000: { role: "tech-lead", title: "Scaffold the repo" },
      T001: { role: "backend", after: ["T000"], title: "Bookings API" },
    });

    // Live: cards appear without a reload and walk the columns to Done.
    await expect(page.getByTestId("card-T000")).toBeVisible();
    await expect(page.getByTestId("col-done").getByTestId("card-T000")).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId("col-done").getByTestId("card-T001")).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId("done-count")).toHaveText("2");
    // With every build task merged the orchestrator opens the release review gate.
    await expect(page.getByTestId("phase-stepper").locator('[aria-current="step"]')).toContainText(
      /Build|Release/,
    );

    // Task drawer: handoff and diff.
    await page.getByTestId("card-T001").click();
    const drawer = page.getByTestId("task-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Bookings API");
    await drawer.getByRole("tab", { name: /Handoff/ }).click();
    await expect(drawer.getByTestId("handoff")).toContainText("What changed");
    await drawer.getByRole("tab", { name: /Diff/ }).click();
    await expect(drawer.getByTestId("task-diff")).toContainText("src/T001.txt");
    await expect(drawer.getByTestId("task-diff")).toContainText("work of T001");
    await drawer.getByRole("tab", { name: /Timeline/ }).click();
    await expect(drawer).toContainText("T001 review → qa");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    // Feed: merge events, chatter hidden by default and shown on demand.
    await goto(page, h, "feed");
    const feed = page.getByTestId("feed");
    await expect(feed.locator('[data-type="merge.ok"]').filter({ hasText: "Merged T000" })).toBeVisible();
    await expect(feed.locator('[data-type="merge.ok"]').filter({ hasText: "Merged T001" })).toBeVisible();
    await expect(feed.locator('[data-type="run.tool"]')).toHaveCount(0);
    await page.getByTestId("hide-chatter").uncheck();
    await expect(feed.locator('[data-type="run.tool"]').first()).toBeAttached();

    // Agents screen lists the team that did the work.
    await goto(page, h, "agents");
    await expect(page.getByTestId("agent-backend-1")).toBeVisible();
    await expect(page.getByTestId("agent-reviewer-1")).toBeVisible();
  });
});

test("questions: the owner answers an `ask @human` in the UI and the task completes", async ({ page }) => {
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
  await openDashboard(page, h, "questions");
  await seed(h, { T001: { role: "backend" } });

  const card = page.locator('[data-testid^="question-Q-"]');
  await expect(card).toContainText("Stripe test keys are needed", { timeout: 90_000 });
  await expect(page.getByTestId("questions-badge")).toContainText("1");
  await waitFor(() => status(h!, "T001") === "blocked", "T001 blocked");
  await waitFor(() => h!.project.svc.runs({ task: "T001" })[0]?.ended_at, "first run ended");

  await card.getByLabel("Your answer").fill("Yes, use the test key");
  await card.getByRole("button", { name: "Send answer" }).click();
  await expect(page.locator('[data-testid^="answered-Q-"]')).toContainText("Yes, use the test key");
  await expect(page.getByText("Nothing needs you right now")).toBeVisible();

  await waitFor(() => status(h!, "T001") === "done", "T001 done", 150_000);
  await goto(page, h, "board");
  await expect(page.getByTestId("col-done").getByTestId("card-T001")).toBeVisible();
});

test("kill switch asks for confirmation in-page, then stops agents and pauses", async ({ page }) => {
  h = await startHarness({
    ...DEFAULT_BUILD_SCENARIO,
    "backend:implement": {
      steps: [
        { botss: ["task", "start", "${BOTSS_TASK}"] },
        { botss: ["progress", "Working on it"] },
        { hang: true },
      ],
    },
  });
  await openDashboard(page, h, "agents");
  await seed(h, { T001: { role: "backend" } });
  await expect(page.getByTestId("agent-backend-1")).toContainText("working", { timeout: 90_000 });

  page.on("dialog", () => {
    throw new Error("native dialogs must not be used");
  });
  await page.getByTestId("kill-switch").click();
  const dialog = page.getByRole("dialog", { name: "Stop every agent now?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(h.project.orch.activeRuns()).toHaveLength(1);

  await page.getByTestId("kill-switch").click();
  await page
    .getByRole("dialog", { name: "Stop every agent now?" })
    .getByRole("button", { name: "Stop all agents" })
    .click();
  await expect(page.getByText(/Kill switch: stopped 1 agent run/)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "paused: kill switch" })).toBeVisible();
  expect(h.project.orch.activeRuns()).toHaveLength(0);
  expect(h.project.svc.state.paused).toBe(true);
  await expect(page.getByRole("banner").getByRole("button", { name: "Resume" })).toBeVisible();
});

test("settings save through PATCH /settings and warn about risky permission modes", async ({ page }) => {
  h = await startHarness(DEFAULT_BUILD_SCENARIO);
  await openDashboard(page, h, "settings");
  const form = page.getByTestId("settings-form");
  await form.getByLabel("Agents running at once").fill("5");
  await form.getByTestId("gate-design_direction").uncheck();
  await form.getByLabel("Model for backend").fill("sonnet");
  await expect(form.getByTestId("permission-warning")).toHaveCount(0);
  await form.getByLabel("Permission mode").selectOption("bypassPermissions");
  await expect(form.getByTestId("permission-warning")).toBeVisible();
  await form.getByLabel("Permission mode").selectOption("dontAsk");
  await form.getByLabel("New check command").fill("pnpm test");
  await form.getByRole("button", { name: "Add check" }).click();
  await form.getByTestId("save-settings").click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await expect(form).toContainText("All changes saved.");
  const s = h.project.svc.settings;
  expect(s.max_concurrent_agents).toBe(5);
  expect(s.gates.design_direction).toBe(false);
  expect(s.gates.prd).toBe(true);
  expect(s.models.backend).toBe("sonnet");
  expect(s.checks).toContain("pnpm test");
  expect(s.permission_mode).toBe("dontAsk");

  // Skills editor: open, edit, save, reset.
  await page.getByRole("button", { name: "SKILL.md" }).first().click();
  const editor = page.getByLabel(/Contents of .*SKILL\.md/);
  await expect(editor).toBeVisible();
  await editor.press("End");
  await editor.pressSequentially("\nOwner note.");
  await page.getByRole("button", { name: "Save file" }).click();
  await expect(page.getByText(/^Saved .*SKILL\.md$/)).toBeVisible();
  await page.getByRole("button", { name: "Reset to default" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset to default" }).click();
  await expect(page.getByText(/reset to the default/)).toBeVisible();
});

test("theme toggle switches light/dark and persists across reloads", async ({ page }) => {
  h = await startHarness(DEFAULT_BUILD_SCENARIO);
  await page.emulateMedia({ colorScheme: "light" });
  await openDashboard(page, h, "idea");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Dark theme" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(16, 18, 23)");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "System theme" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
});
