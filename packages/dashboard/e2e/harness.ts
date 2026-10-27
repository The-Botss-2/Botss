// Shared e2e plumbing: a real BotssServer with the fake `claude` (tests/helpers.ts startHarness), serving the built
// dashboard from packages/dashboard/dist. Playwright runs with one worker because the harness configures the fake
// claude through process-wide environment variables.
import type { Page } from "@playwright/test";
import {
  cleanup,
  DEFAULT_BUILD_SCENARIO,
  implementSteps,
  REPO,
  seedBuild,
  startHarness,
  taskFile,
  waitFor,
  type Harness,
} from "../../../tests/helpers.ts";

export {
  cleanup,
  DEFAULT_BUILD_SCENARIO,
  implementSteps,
  REPO,
  seedBuild,
  startHarness,
  taskFile,
  waitFor,
  type Harness,
};

/** The tokened URL `botss up` prints, pointing at a screen. */
export function dashboardUrl(h: Harness, screen = "board"): string {
  return `${h.server.url}/?token=${h.server.tokens.master}#/p/${h.project.id}/${screen}`;
}

export async function openDashboard(page: Page, h: Harness, screen = "board"): Promise<void> {
  await page.goto(dashboardUrl(h, screen));
  await page.getByTestId("project-name").filter({ hasText: h.project.paths.name }).waitFor();
}

/** Go to another screen inside the already-open app (keeps the session token). */
export async function goto(page: Page, h: Harness, screen: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/p/${h.project.id}/${screen}`);
}

export const status = (h: Harness, id: string) => h.project.svc.task(id)?.status;

export interface SeedTask {
  role: string;
  title?: string;
  after?: string[];
  size?: "S" | "M" | "L";
}

/** Like seedBuild in tests/helpers.ts, but builds the task specs directly instead of parsing task files, so the
 * dashboard e2e does not depend on the plan parser. The task file text is still stored as `source` for the drawer. */
export async function seed(h: Harness, tasks: Record<string, SeedTask>): Promise<void> {
  const specs = Object.entries(tasks).map(([id, t]) => {
    const source = taskFile(id, { role: t.role, after: t.after, title: t.title, size: t.size });
    return {
      id,
      title: t.title ?? `Task ${id}`,
      role: t.role,
      covers: [],
      after: t.after ?? [],
      owns: [`src/${id}.txt`],
      may_touch: [],
      verify: `test -f src/${id}.txt`,
      size: t.size ?? "S",
      body: source.split("---\n").slice(2).join("---\n"),
      source,
    };
  });
  h.project.svc.importPlan(specs as never, "test");
  h.project.svc.setPhase("build");
  await h.project.orch.tick();
}
