# Playwright patterns

Patterns for the committed E2E suite in `e2e/`, using `@playwright/test` with TypeScript. Adapt paths and ports to the project's architecture doc.

## Contents
1. Config
2. Auth setup project
3. Test data
4. A journey test
5. Page objects (when they help)
6. Waiting correctly
7. Error paths
8. Accessibility checks
9. Running and debugging

## 1. Config

```ts
// e2e/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: CI,                 // a stray test.only fails CI
  retries: CI ? 2 : 0,            // retries collect traces; they do not make flaky tests "pass"
  workers: CI ? 2 : undefined,
  reporter: [['html', { open: 'never' }], ['junit', { outputFile: 'results/junit.xml' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
      dependencies: ['setup'],
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], storageState: '.auth/user.json' },
      dependencies: ['setup'],
      grep: /@mobile/,
    },
  ],
  // Playwright starts both servers, locally and in CI. CI must not start them separately.
  webServer: [
    {
      // Backend with test-only routes enabled. The database must already be running
      // (`docker compose up -d db` locally; a service container in CI).
      command: 'uv run alembic upgrade head && uv run uvicorn app.main:app --port 8000',
      cwd: '../backend',
      url: 'http://localhost:8000/api/health/ready',
      env: { ENVIRONMENT: 'test' },
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
    {
      // Production build in CI; dev server locally for speed.
      command: CI ? 'pnpm build && pnpm start' : 'pnpm dev',
      cwd: '../frontend',
      url: 'http://localhost:3000',
      reuseExistingServer: !CI,
      timeout: 180_000,
    },
  ],
});
```

`webServer` inherits the environment of the shell that runs Playwright, so `DATABASE_URL`, `SESSION_SECRET`, and `API_INTERNAL_URL` must be set there (from `.env` locally, from job env in CI). `ENVIRONMENT=test` is what turns on the backend's test-only routes (`/api/test/...`); they do not exist in any other environment, so never point these tests at a shared, staging, or production backend.

Playwright writes traces, screenshots, and videos to `test-results/` and the HTML report to `playwright-report/`. Add `.auth/`, `results/`, `test-results/`, and `playwright-report/` to `e2e/.gitignore`.

## 2. Auth setup project

Sign in once through the UI and reuse the session. Only the sign-in journey test signs in through the UI again.

```ts
// e2e/tests/auth.setup.ts
import { test as setup, expect } from '@playwright/test';
import { createUser } from '../support/api';

setup('sign in as a standard user', async ({ page }) => {
  const user = await createUser();               // via API or seeding endpoint
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your orders' })).toBeVisible();
  await page.context().storageState({ path: '.auth/user.json' });
});
```

For several roles, make one setup test and one storage file per role (`.auth/admin.json`).

## 3. Test data

Each test creates what it needs, with unique values, through the API or the backend's test-only seeding routes. Those routes are registered only when the backend runs with `ENVIRONMENT=test` (the webServer config above sets it). If `/api/test/users` returns 404, the backend was started without it; fix the setup rather than seeding some other way. Never rely on data another test created.

```ts
// e2e/support/api.ts
import { request, type Page } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:8000'; // backend directly, for seeding only
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function createUser(overrides: Partial<{ email: string; password: string }> = {}) {
  const ctx = await request.newContext({ baseURL: API });
  const user = { email: `qa-${unique()}@example.test`, password: 'Correct-Horse-9', ...overrides };
  const res = await ctx.post('/api/test/users', { data: user });
  if (!res.ok()) throw new Error(`createUser failed: ${res.status()} ${await res.text()}`);
  await ctx.dispose();
  return user;
}

// You write this, against the project's test seeding route. Signature:
//   createOrderForCurrentUser(page, { status }) -> { id: string; number: string }
// It reads the session cookie from the page's storage state and calls a test-only
// route such as POST /api/test/orders, so the order belongs to the signed-in user.
export async function createOrderForCurrentUser(
  page: Page,
  opts: { status: 'pending' | 'preparing' | 'delivered' | 'cancelled' },
): Promise<{ id: string; number: string }> {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'botss_session');
  if (!session) throw new Error('No botss_session cookie: is the auth setup project running?');
  const ctx = await request.newContext({ baseURL: API, extraHTTPHeaders: { Cookie: `botss_session=${session.value}` } });
  const res = await ctx.post('/api/test/orders', { data: { status: opts.status } });
  if (!res.ok()) throw new Error(`createOrderForCurrentUser failed: ${res.status()} ${await res.text()}`);
  const order = await res.json();
  await ctx.dispose();
  return { id: order.id, number: order.number };
}
```

`/api/test/users` and `/api/test/orders` are examples: use whatever test-only routes the architecture defines, and ask the tech lead for one (`botss ask @tech-lead`) rather than inventing it if none exists. `order.number` assumes the contract has a human-readable order number; use the field the contract actually has.

## 4. A journey test

```ts
// e2e/tests/uj-2-cancel-order.spec.ts
import { test, expect } from '@playwright/test';
import { createOrderForCurrentUser } from '../support/api';

test.describe('UJ-2: customer cancels a pending order', () => {
  test('cancels a pending order and sees it marked cancelled', async ({ page }) => {
    const order = await createOrderForCurrentUser(page, { status: 'pending' });

    await test.step('open the order from the list', async () => {
      await page.goto('/orders');
      await page.getByRole('link', { name: `Order ${order.number}` }).click();
      await expect(page).toHaveURL(new RegExp(`/orders/${order.id}$`));
    });

    await test.step('cancel and confirm', async () => {
      await page.getByRole('button', { name: 'Cancel order' }).click();
      // Copy comes from the screen spec: the dialog's confirm button is also "Cancel order".
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
    });

    await test.step('see the result', async () => {
      await expect(page.getByRole('status')).toHaveText('Order cancelled.');
      await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0); // dialog closed, button gone
    });
  });
});
```

## 5. Page objects (when they help)

Use a page object when three or more tests drive the same screen. Keep assertions in tests, and keep page objects to locators and actions.

```ts
// e2e/pages/order-page.ts
import type { Page, Locator } from '@playwright/test';

export class OrderPage {
  readonly cancelButton: Locator;
  readonly status: Locator;
  constructor(private page: Page) {
    this.cancelButton = page.getByRole('button', { name: 'Cancel order' });
    this.status = page.getByTestId('order-status');
  }
  async goto(id: string) { await this.page.goto(`/orders/${id}`); }
  async cancel() {
    await this.cancelButton.click();
    await this.page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
  }
}
```

## 6. Waiting correctly

| Instead of | Use |
|---|---|
| `await page.waitForTimeout(2000)` | `await expect(locator).toBeVisible()` |
| `await page.waitForLoadState('networkidle')` | An assertion on the content that proves the page is ready |
| Checking `isVisible()` in an `if` | `expect(...)`, which retries until the timeout |
| Clicking, then waiting for a response | Assert on the visible result (see below) |

Prefer asserting on what the user sees after the action: a toast, a new row, a changed badge. In this stack most mutations are **Server Actions**, which POST to the current page URL with a `Next-Action` header, not to `/api/...`, so waiting for a `/api/orders` response never matches. Only when a Client Component calls the API from the browser (through the same-origin `/api/*` proxy) can you wait on the request, and you must start the wait before the click:

```ts
// Only for browser-side fetches to /api/*, not for Server Action forms.
const saved = page.waitForResponse((r) => r.url().includes('/api/orders') && r.request().method() === 'POST');
await page.getByRole('button', { name: 'Place order' }).click();
expect((await saved).status()).toBe(201);
```

A fixed delay is only acceptable when the behavior itself is time-based (debounced search), with a comment saying so, and preferably with `page.clock` to control time instead.

## 7. Error paths

Know where the request runs before you mock it.

**Browser-side requests** (Client Components and TanStack Query calling `/api/*` through the Next.js proxy) can be intercepted with `page.route`:

```ts
test('shows a retryable error when refreshing the list fails', async ({ page }) => {
  await page.route('**/api/orders?*', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Something went wrong.' } } }),
  );
  await page.goto('/orders');
  await page.getByRole('button', { name: 'Load more orders' }).click();
  await expect(page.getByRole('alert')).toContainText("couldn't load");
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});
```

**Server Component fetches and Server Actions** run on the Next.js server, which calls the backend directly. The browser never sees those requests, so `page.route()` cannot touch them. To test their error UI:
* Put the backend into the failing state: seed data that triggers the error (an order already `preparing`, so cancelling returns 409), or use a test-only fault route such as `POST /api/test/faults {"orders_list": 503}`, which exists only when the backend runs with `ENVIRONMENT=test`.
* Or run that test against a stub backend started by the test's own fixture.
* Then assert on the visible error UI, not on network traffic.

Do not test Server Component errors by mocking the browser; the test will pass while proving nothing.

## 8. Accessibility checks

```ts
import AxeBuilder from '@axe-core/playwright';

test('order page has no serious accessibility violations', async ({ page }) => {
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Your orders' })).toBeVisible();
  // axe tags each WCAG version separately; include 2.0, 2.1, and 2.2 A/AA rules.
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(serious, JSON.stringify(serious.map((v) => [v.id, v.nodes.length]), null, 2)).toEqual([]);
});
```

Automated scans find only a portion of accessibility problems. They miss whether focus order makes sense, whether labels are meaningful, and whether the flow works with a keyboard alone. Check those by hand in verify runs and add keyboard-only journey tests for the most important flows:

```ts
await page.keyboard.press('Tab');
await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
```

## 9. Running and debugging

```bash
cd e2e
pnpm exec playwright test                          # all
pnpm exec playwright test tests/uj-2-cancel-order.spec.ts --repeat-each=3   # flakiness check
pnpm exec playwright test --project=mobile
pnpm exec playwright show-trace test-results/<test-folder>/trace.zip
pnpm exec playwright show-report                   # HTML report from playwright-report/
```

When a test fails, open the trace before changing anything. It shows the DOM, network, and console at every step, and usually names the cause directly.
