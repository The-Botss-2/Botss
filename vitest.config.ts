import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "packages/dashboard/**"],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
