// Screenshot tour: drives a real (fake-claude) build, stages realistic planning content, and saves a PNG of every
// screen to docs/screenshots/ at 1440x900 (board and feed in light and dark).
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  cleanup,
  DEFAULT_BUILD_SCENARIO,
  goto,
  openDashboard,
  REPO,
  seed,
  startHarness,
  waitFor,
  type Harness,
} from "./harness.ts";

const OUT = path.join(REPO, "docs", "screenshots");

let h: Harness | undefined;
test.afterAll(async () => {
  await cleanup(h);
});

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function theme(page: Page, t: "light" | "dark") {
  await page.getByRole("button", { name: t === "dark" ? "Dark theme" : "Light theme" }).click();
}

const PRD_V1 = `# PRD: Fade & Co. booking

## Summary
Customers book a barber and a time slot online and pay a small deposit. The owner sees the day's schedule on a phone.

## Users
| User | Goal |
|---|---|
| Customer | Book a cut in under a minute |
| Barber | Know who is next |
| Owner | Fill the chairs, cut no-shows |

## Journeys
1. Customer picks a barber, a service and a slot, pays a deposit, gets a confirmation.
2. Barber opens *Today* and sees the queue.
`;

const PRD_V2 = `${PRD_V1}3. Customer gets an SMS reminder the evening before and can cancel up to 4 hours ahead.

## Out of scope (v1)
- Gift cards
- Loyalty points

## Acceptance criteria
- [x] Deposit is refunded automatically on a cancellation more than 4 hours ahead
- [ ] No-show rate is visible per week
`;

const ARCH = `# Architecture

A Next.js frontend talks to a FastAPI backend over a typed REST contract. Postgres stores bookings; a worker sends reminders.

\`\`\`mermaid
flowchart LR
  C[Customer browser] -->|HTTPS| W[Next.js web]
  W -->|REST /api| A[FastAPI]
  A --> DB[(Postgres)]
  A --> Q[[Reminder queue]]
  Q --> S[SMS provider]
  A --> P[Stripe deposits]
\`\`\`

## Decisions
- **D-001** Deposits via Stripe Checkout, not custom card forms.
- **D-002** Slots are computed, not stored, to avoid double booking races.
`;

const OPENAPI = `openapi: 3.1.0
info:
  title: Fade & Co. Bookings API
  version: 1.0.0
paths:
  /api/barbers:
    get:
      summary: List barbers with their services
      responses: { "200": { description: ok } }
  /api/slots:
    get:
      summary: Free slots for a barber and day
      responses: { "200": { description: ok } }
  /api/bookings:
    post:
      summary: Create a booking and a deposit checkout session
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/NewBooking" }
      responses: { "201": { description: created }, "409": { description: slot taken } }
  /api/bookings/{id}:
    delete:
      summary: Cancel a booking (refunds the deposit if more than 4h ahead)
      responses: { "204": { description: cancelled } }
components:
  schemas:
    NewBooking:
      type: object
      required: [barberId, serviceId, startsAt, phone]
      properties:
        barberId: { type: string }
        serviceId: { type: string }
        startsAt: { type: string, format: date-time }
        phone: { type: string }
    Booking:
      type: object
      properties:
        id: { type: string }
        status: { type: string }
        depositCents: { type: integer }
`;

const TOKENS = {
  color: {
    brand: {
      "ink-900": "#1B1A17",
      "chalk-50": "#F7F3EA",
      "brass-500": "#B8862B",
      "oxblood-600": "#7A2E2A",
      "sage-400": "#8FA58A",
    },
    semantic: {
      bg: "#F7F3EA",
      surface: "#FFFDF8",
      text: "#1B1A17",
      "text-muted": "#5D5A52",
      primary: "#7A2E2A",
      "primary-foreground": "#FFFFFF",
      border: "#DDD5C4",
      danger: "#B42318",
    },
  },
  font: { display: "Fraunces, serif", body: "Work Sans, sans-serif", mono: "JetBrains Mono, monospace" },
  "font-size": { xs: "12px", sm: "14px", base: "16px", lg: "20px", xl: "28px", display: "40px" },
  spacing: { "1": "4px", "2": "8px", "3": "12px", "4": "16px", "6": "24px", "8": "32px", "12": "48px" },
  radius: { sm: "2px", md: "6px", pill: "999px" },
};

const SCREEN_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;font-family:Georgia,serif;background:#F7F3EA;color:#1B1A17}
header{display:flex;justify-content:space-between;align-items:center;padding:20px 28px;border-bottom:1px solid #DDD5C4}
h1{font-size:40px;margin:32px 28px 8px;font-weight:600}
p.sub{margin:0 28px 24px;color:#5D5A52;font-family:system-ui}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;padding:0 28px 28px}
.card{background:#FFFDF8;border:1px solid #DDD5C4;border-radius:6px;padding:16px;font-family:system-ui}
.card b{display:block;font-family:Georgia,serif;font-size:20px;margin-bottom:6px}
.slots{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.slot{border:1px solid #7A2E2A;color:#7A2E2A;border-radius:999px;padding:4px 10px;font-size:13px}
.slot.on{background:#7A2E2A;color:#fff}
.btn{background:#7A2E2A;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:15px}
</style></head><body>
<header><strong>Fade &amp; Co.</strong><button class="btn">Book a chair</button></header>
<h1>Pick your barber</h1><p class="sub">Thursday 29 October · deposits are refundable up to 4 hours before</p>
<div class="grid">
<div class="card"><b>Marco</b>Skin fades, beard sculpting<div class="slots"><span class="slot">10:00</span><span class="slot on">10:45</span><span class="slot">13:30</span></div></div>
<div class="card"><b>Aisha</b>Scissor cuts, curly hair<div class="slots"><span class="slot">09:15</span><span class="slot">11:00</span><span class="slot">16:20</span></div></div>
<div class="card"><b>Tomás</b>Classic cuts, hot towel shave<div class="slots"><span class="slot">12:00</span><span class="slot">15:40</span></div></div>
</div></body></html>`;

test("screenshot tour", async ({ page }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(OUT, { recursive: true });
  h = await startHarness(
    {
      ...DEFAULT_BUILD_SCENARIO,
      "task:T004": {
        steps: [
          { botss: ["whoami"] },
          { botss: ["task", "start", "${BOTSS_TASK}"] },
          { write: "src/${BOTSS_TASK}.txt", content: "booking reminders\n" },
          { botss: ["progress", "Wiring the reminder worker to the SMS provider"] },
          {
            botss: [
              "msg",
              "@frontend",
              "Reminder opt-out flag is `sms_opt_in` on Booking; defaults to true.",
            ],
          },
          {
            todo: [
              { content: "Read the booking model", status: "completed" },
              { content: "Add the reminder job table", status: "completed" },
              {
                content: "Write the reminder worker",
                status: "in_progress",
                activeForm: "Writing the reminder worker",
              },
              { content: "Hook up the SMS provider", status: "pending" },
              { content: "Add the opt-out flag", status: "pending" },
              { content: "Run the tests", status: "pending" },
            ],
          },
          { hang: true },
        ],
      },
      "task:T006": {
        steps: [
          { botss: ["task", "start", "${BOTSS_TASK}"] },
          {
            text: "The Today queue needs the walk-in list and the booked slots merged and sorted by start time. I'll read the slots contract first, then build the list component.",
          },
          { bash: "cat .botss/docs/contracts/openapi.yaml | head -20", allowFail: true },
          {
            write: "src/${BOTSS_TASK}.txt",
            content:
              "export function TodayQueue({ slots, walkIns }) {\n  const queue = [...slots, ...walkIns].sort(byStart);\n  return <QueueList items={queue} />;\n}\n",
          },
          {
            append: "src/${BOTSS_TASK}.txt",
            content: "\nexport const byStart = (a, b) => a.startsAt.localeCompare(b.startsAt);\n",
          },
          { text: "Queue renders. Next: refresh when a walk-in is added (that was QA's bug B-0001)." },
          { bash: 'node -e "process.exit(0)"', allowFail: true },
          {
            todo: [
              { content: "Read the slots contract", status: "completed" },
              { content: "Build the queue list component", status: "completed" },
              { content: "Merge walk-ins with booked slots", status: "completed" },
              {
                content: "Refresh when a walk-in is added",
                status: "in_progress",
                activeForm: "Refreshing the queue on new walk-ins",
              },
              { content: "Run the tests", status: "pending" },
            ],
          },
          { hang: true },
        ],
      },
    },
    { name: "fade-and-co", settings: { max_concurrent_agents: 4 } },
  );
  const svc = h.project.svc;
  const integ = h.project.paths.integration;

  // ---- planning content
  svc.patchState({
    idea: {
      text: "A booking site for my barbershop, **Fade & Co.**: customers pick a barber and a slot, pay a small deposit, and get a reminder the evening before. I want to see today's queue on my phone and cut no-shows.",
      stakes: "customer-facing",
      links: ["https://example.com/competitor-booking", "https://example.com/our-instagram"],
      attachments: ["shop-floor-sketch.png"],
    },
  });
  svc.submitDoc(
    "idea",
    ".botss/docs/idea.md",
    "# Idea\n\nBooking site for Fade & Co.",
    "human",
    null,
    "approved",
  );
  svc.submitDoc("prd", ".botss/docs/prd.md", PRD_V1, "pm-1", "pm");
  svc.setDocStatus("prd", "changes_requested", "Add reminders and the cancellation rule.");
  svc.submitDoc("prd", ".botss/docs/prd.md", PRD_V2, "pm-1", "pm");
  svc.submitDoc("architecture", ".botss/docs/architecture.md", ARCH, "tech-lead-1", "tech-lead", "approved");
  svc.submitDoc(
    "contracts/openapi.yaml",
    ".botss/docs/contracts/openapi.yaml",
    OPENAPI,
    "tech-lead-1",
    "tech-lead",
    "approved",
  );
  svc.addDecision(
    "Deposits via Stripe Checkout",
    "No card data touches our servers; PCI scope stays minimal.",
    ["backend", "frontend"],
    "tech-lead-1",
    "tech-lead",
    null,
  );
  fs.mkdirSync(path.join(integ, ".botss/docs/contracts"), { recursive: true });
  fs.mkdirSync(path.join(integ, ".botss/docs/design/screens"), { recursive: true });
  fs.writeFileSync(
    path.join(integ, ".botss/docs/contracts/design-tokens.json"),
    JSON.stringify(TOKENS, null, 2),
  );
  fs.writeFileSync(path.join(integ, ".botss/docs/design/screens/book-a-chair.html"), SCREEN_HTML);
  fs.mkdirSync(path.join(integ, ".botss/docs/design/directions"), { recursive: true });
  const dirHtml = (bg: string, fg: string, accent: string, font: string, name: string) =>
    `<!doctype html><body style="margin:0;background:${bg};color:${fg};font-family:${font}"><div style="padding:48px 64px"><div style="font-size:14px;letter-spacing:.2em;color:${accent}">FADE &amp; CO.</div><h1 style="font-size:72px;margin:24px 0 12px">${name}</h1><p style="font-size:22px;max-width:640px;opacity:.8">Book a chair in under a minute. Deposits refundable up to 4 hours before.</p><button style="margin-top:28px;background:${accent};color:${bg};border:0;padding:16px 28px;font-size:20px;border-radius:4px">Book a chair</button></div></body>`;
  fs.writeFileSync(
    path.join(integ, ".botss/docs/design/directions/A.html"),
    dirHtml("#1B1A17", "#F2EFE6", "#B8862B", "Impact, sans-serif", "Chalkboard"),
  );
  fs.writeFileSync(
    path.join(integ, ".botss/docs/design/directions/B.html"),
    dirHtml("#F7F3EA", "#1B1A17", "#7A2E2A", "Georgia, serif", "Barber pole heritage"),
  );
  fs.writeFileSync(
    path.join(integ, ".botss/docs/design/directions/C.html"),
    dirHtml("#FFFFFF", "#2F3437", "#5F7A5A", "system-ui, sans-serif", "Clean clinic"),
  );
  fs.writeFileSync(
    path.join(integ, ".botss/docs/design/screens/book-a-chair.md"),
    "# Book a chair\n\n## Purpose\nPick a barber and a slot in under a minute.\n",
  );

  // ---- build: a real fake-claude run of five tasks; T004 hangs so one agent is visibly working.
  await seed(h, {
    T000: { role: "tech-lead", title: "Scaffold monorepo and CI", size: "M" },
    T001: { role: "backend", after: ["T000"], title: "Barbers and slots API", size: "M" },
    T002: { role: "frontend", after: ["T000"], title: "Barber picker screen", size: "M" },
    T003: { role: "backend", after: ["T001"], title: "Bookings + Stripe deposits", size: "L" },
    T004: { role: "devops", after: ["T000"], title: "Reminder worker", size: "S" },
    T005: { role: "frontend", after: ["T002", "T003"], title: "Checkout and confirmation", size: "M" },
    T006: { role: "frontend", after: ["T002"], title: "Today queue for barbers", size: "S" },
    T007: { role: "backend", after: ["T003"], title: "Cancellation and refunds", size: "M" },
    T008: { role: "qa", after: ["T005", "T007"], title: "End-to-end booking journey", size: "S" },
  });

  await openDashboard(page, h, "board");
  await theme(page, "light");
  await waitFor(
    () => ["T001", "T002"].every((id) => svc.task(id)?.status === "done"),
    "T001+T002 done",
    240_000,
  );
  await waitFor(() => h!.project.orch.activeRuns().some((r) => r.task === "T004"), "T004 running", 60_000);
  await waitFor(() => h!.project.orch.activeRuns().some((r) => r.task === "T006"), "T006 running", 90_000);
  await waitFor(
    () =>
      svc
        .events({ run: h!.project.orch.activeRuns().find((r) => r.task === "T006")!.runId, limit: 100 })
        .some((e) => /walk-in/.test(e.summary)),
    "T006 streamed",
    60_000,
  );

  // Freeze the board in an interesting state: pause, then shape the rest.
  h.project.orch.pause("screenshot tour");
  await waitFor(
    () => h!.project.orch.activeRuns().every((r) => r.task === "T004" || r.task === "T006"),
    "other runs finished",
    120_000,
  );
  const shape = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    svc.setStatus(id, status as never, { force: true, actor: "orchestrator", extra: extra as never });
  if (svc.task("T003")?.status !== "done")
    shape("T003", "review", { assignee: "backend-1", review_round: 1 });
  shape("T007", "blocked", {
    assignee: "backend-2",
    blocked_on: "@human",
    blocked_reason: "Which Stripe account receives refunds?",
  });
  shape("T005", "changes_requested", { assignee: "frontend-1", review_round: 2 });
  svc.createBug(
    "T003",
    "major",
    "Queue does not refresh after a walk-in",
    "Steps: add a walk-in. Expected: queue shows it. Actual: needs reload.",
    "qa-1",
    "qa",
  );
  svc.updateTask("T005", { done_status: "DONE_WITH_CONCERNS" });

  // Owner inbox: a design direction batch and a single ask, plus an alert.
  svc.createTask({
    id: "P-007",
    kind: "planning",
    mode: "direction",
    title: "Visual direction",
    role: "designer",
    status: "blocked",
  });
  const dm = svc.message(
    { agent: "designer-1", role: "designer" },
    "@human",
    "Three directions for Fade & Co.",
    "batch",
    { task: "P-007" },
  );
  svc.createQuestion({
    messageId: dm.id as string,
    from: "designer-1",
    to: "@human",
    task: "P-007",
    runId: null,
    sessionId: null,
    body: "Three directions for Fade & Co.",
    batch: {
      intro: "Three directions for Fade & Co. I recommend B: it feels like the shop itself.",
      questions: [
        {
          id: "Q1",
          topic: "Direction",
          question: "Which look should the team build toward?",
          options: [
            {
              key: "A",
              label: "Chalkboard: matte black, chalk white, brass accents",
              palette: ["#1B1A17", "#F2EFE6", "#B8862B", "#5D5A52"],
              type: "Oswald + Inter",
              mood: "Bold, loud, street-corner",
            },
            {
              key: "B",
              label: "Barber pole heritage: cream paper, oxblood, brass",
              palette: ["#F7F3EA", "#7A2E2A", "#B8862B", "#1B1A17"],
              type: "Fraunces + Work Sans",
              mood: "Warm, old-school, trustworthy",
            },
            {
              key: "C",
              label: "Clean clinic: white, sage, graphite",
              palette: ["#FFFFFF", "#8FA58A", "#2F3437", "#E6ECE5"],
              type: "Manrope",
              mood: "Calm, precise, modern",
            },
          ],
          recommended: "B",
          why_it_matters:
            "Every screen, email and the SMS tone follow this choice; changing it later means redoing the screens.",
        },
      ],
    },
  });
  const am = svc.message(
    { agent: "backend-2", role: "backend" },
    "@human",
    "Which Stripe account receives refunds?",
    "ask",
    { task: "T007" },
  );
  svc.createQuestion({
    messageId: am.id as string,
    from: "backend-2",
    to: "@human",
    task: "T007",
    runId: null,
    sessionId: null,
    body: "Which Stripe account should receive refunds: the **shop account** or your **personal** one? I need the account id for `STRIPE_ACCOUNT`.",
  });
  svc.alert(
    "Checks failed after merging T002: `pnpm test` (1 failing test). The tech lead opened an integrate task.",
    "T002",
  );

  // ---- screens
  await page.reload();
  await page.getByTestId("project-name").waitFor();
  await expect(page.getByTestId("card-T007")).toBeVisible();
  await shot(page, "board-light");
  await theme(page, "dark");
  await shot(page, "board-dark");
  await theme(page, "light");

  await page.getByTestId("card-T001").click();
  await page.getByTestId("task-drawer").getByRole("tab", { name: /Diff/ }).click();
  await expect(page.getByTestId("task-diff")).toContainText("src/T001.txt");
  await shot(page, "task-drawer-diff");
  await page
    .getByTestId("task-drawer")
    .getByRole("tab", { name: /Handoff/ })
    .click();
  await shot(page, "task-drawer-handoff");
  await page.keyboard.press("Escape");

  await goto(page, h, "feed");
  await expect(page.getByTestId("feed")).toBeVisible();
  await shot(page, "feed-light");
  await theme(page, "dark");
  await shot(page, "feed-dark");
  await page.getByTestId("hide-chatter").uncheck();
  await shot(page, "feed-dark-chatter");
  await theme(page, "light");

  await goto(page, h, "agents");
  await expect(page.getByTestId("agent-devops-1")).toContainText("working");
  await expect(page.getByTestId("agent-frontend-1").getByTestId("plan-checklist")).toBeVisible();
  await expect(page.getByTestId("agent-devops-1").getByTestId("plan-checklist")).toBeVisible();
  await shot(page, "agents-live");
  await page.getByTestId("agent-frontend-1").getByTestId("details-toggle").click();
  await page.getByTestId("agent-frontend-1").getByTestId("agent-details").scrollIntoViewIfNeeded();
  await shot(page, "agents-details");
  await page.getByTestId("agent-frontend-1").getByTestId("details-toggle").click();
  await page.evaluate(() => document.getElementById("main")?.scrollTo(0, 0));
  await shot(page, "agents");

  await goto(page, h, "questions");
  await expect(page.getByTestId("alert")).toBeVisible();
  await shot(page, "questions");

  await goto(page, h, "design");
  await expect(page.getByTestId("token-viewer")).toBeVisible();
  await page.locator("iframe[title^='Mockup']").waitFor();
  await expect(page.locator("[data-testid^='direction-preview-']")).toHaveCount(3);
  await shot(page, "design");
  svc.setPhase("design");
  svc.submitDoc(
    "design",
    ".botss/docs/design/DESIGN.md",
    "# Design\n\nBarber pole heritage: tokens and screens.\n",
    "designer-1",
    "designer",
  );
  await expect(page.getByTestId("gate-bar")).toContainText("Review the screens");
  await page.getByTestId("design-review").scrollIntoViewIfNeeded();
  await shot(page, "design-review");
  svc.setPhase("build");

  await goto(page, h, "idea");
  await expect(page.getByTestId("idea-readonly")).toBeVisible();
  await shot(page, "idea");

  svc.setPhase("prd_review");
  await goto(page, h, "docs/prd");
  await expect(page.getByTestId("gate-bar")).toBeVisible();
  await shot(page, "docs-prd");
  await page.getByRole("tab", { name: /Compare versions/ }).click();
  await expect(page.locator(".d2h-wrapper")).toBeVisible();
  await shot(page, "docs-compare");

  await goto(page, h, "docs/architecture");
  await expect(page.locator(".mermaid-block svg")).toBeVisible({ timeout: 30_000 });
  await shot(page, "docs-architecture");
  await goto(page, h, "docs/contracts/openapi.yaml");
  await expect(page.getByTestId("openapi-view")).toBeVisible();
  await shot(page, "docs-openapi");

  svc.setPhase("plan_review");
  await goto(page, h, "team");
  await expect(page.getByTestId("dag")).toBeVisible();
  await shot(page, "team-builder");
  svc.setPhase("build");

  await goto(page, h, "preview");
  await shot(page, "preview");

  await goto(page, h, "settings");
  await expect(page.getByTestId("settings-form")).toBeVisible();
  await shot(page, "settings");

  await goto(page, h, "board");
  await page.getByTestId("request-change").click();
  await page
    .getByTestId("change-dialog")
    .getByLabel("The change")
    .fill("Customers should be able to book two services in one visit (cut + beard) with a single deposit.");
  await shot(page, "change-request");
  await page.getByTestId("change-dialog").getByRole("button", { name: "Cancel" }).click();
  const now = new Date().toISOString();
  svc.patchState({
    changes: [
      {
        id: "CR-001",
        text: "Customers can book two services in one visit with a single deposit.",
        status: "prd_review",
        created_at: now,
        updated_at: now,
        attachments: [],
      },
    ],
  } as never);
  svc.submitDoc(
    "prd",
    ".botss/docs/prd.md",
    `${PRD_V2}\n## FR-12 Combined services\nA booking can hold two services; one deposit covers both.\n\n## Changelog\n- CR-001: combined services\n`,
    "pm-1",
    "pm",
  );
  await goto(page, h, "docs/prd");
  await expect(page.getByTestId("change-callout")).toBeVisible();
  await expect(page.getByTestId("gate-bar")).toContainText("CR-001 updated the PRD");
  await shot(page, "change-review");

  // Notifications: a few live ones (toast) and the bell panel open.
  await goto(page, h, "board");
  svc.setStatus("T003", "done", { force: true, actor: "orchestrator", reason: "merged" });
  svc.alert("Checks failed after merging T003: `pnpm test` (2 failing tests).", "T003");
  const am2 = svc.message(
    { agent: "frontend-1", role: "frontend" },
    "@human",
    "Should the queue show customers' phone numbers to barbers?",
    "ask",
    { task: "T006" },
  );
  void am2;
  await expect(page.getByTestId("notify-toast").first()).toBeVisible();
  await page.getByTestId("bell").click();
  await expect(page.getByTestId("bell-panel")).toBeVisible();
  await shot(page, "notifications");
  await page.keyboard.press("Escape");

  await page.goto(`${h.server.url}/#/open?path=${encodeURIComponent(h.dir)}`);
  await expect(page.getByTestId("folder-picker")).toBeVisible();
  await expect(page.getByTestId("fs-entry-fade-and-co")).toBeVisible();
  await shot(page, "folder-picker");
  await page.getByTestId("folder-picker").getByRole("button", { name: "Cancel" }).click();

  await page.goto(`${h.server.url}/#/`);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await shot(page, "projects");

  const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".png"));
  expect(files.length).toBeGreaterThanOrEqual(26);
});
