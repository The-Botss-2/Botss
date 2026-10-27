import { defineConfig, devices } from "@playwright/test";

// e2e runs against a real BotssServer with the fake claude (see e2e/harness.ts), which serves the built dashboard.
// Build first: `pnpm --filter @botss/dashboard e2e` runs `vite build` then this config.
export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "e2e", testIgnore: /screenshots\.spec\.ts/ },
    { name: "screenshots", testMatch: /screenshots\.spec\.ts/ },
  ],
});
