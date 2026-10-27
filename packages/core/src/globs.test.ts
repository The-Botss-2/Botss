import { describe, expect, it } from "vitest";
import { globsOverlap, literalBase, matchesAny } from "./globs.ts";

describe("literalBase", () => {
  it.each([
    ["backend/app/**", "backend/app"],
    ["backend/app/api/orders.py", "backend/app/api/orders.py"],
    ["**/Dockerfile", ""],
    ["frontend/src/*.tsx", "frontend/src"],
    ["./e2e/**", "e2e"],
  ])("%s -> %s", (glob, base) => expect(literalBase(glob)).toBe(base));
});

describe("globsOverlap", () => {
  const cases: [string, string, boolean][] = [
    ["backend/**", "backend/tests/**", true],
    ["backend/**", "frontend/**", false],
    ["backend/app/api/orders.py", "backend/app/api/orders.py", true],
    ["backend/app/api/orders.py", "backend/app/api/users.py", false],
    ["backend/app/api/*.py", "backend/app/api/orders.py", true],
    ["backend/app/api/*.py", "backend/app/api/README.md", false],
    ["backend/**/*.py", "backend/**/*.ts", false],
    ["backend/**/*.py", "backend/**", true],
    ["**/Dockerfile", "backend/**", true],
    ["**/Dockerfile", "backend/**/*.py", false],
    ["frontend/**/*.test.*", "frontend/src/app/page.tsx", false],
    ["frontend/**/*.test.*", "frontend/src/**", true],
    ["backend", "backend/app/main.py", true],
    ["docker-compose*.yml", "docker-compose.yml", true],
    ["docker-compose*.yml", "Makefile", false],
    [".botss/docs/**", "backend/**", false],
    ["src/{a,b}/**", "src/a/x.ts", true],
  ];
  it.each(cases)("%s vs %s -> %s", (a, b, want) => {
    expect(globsOverlap(a, b).overlap).toBe(want);
    expect(globsOverlap(b, a).overlap).toBe(want);
  });

  it("reports an overlap when an existing repo file matches both patterns", () => {
    const r = globsOverlap("src/**/*.ts", "src/lib/?tils.ts", ["src/lib/utils.ts"]);
    expect(r.overlap).toBe(true);
    expect(r.reason).toContain("src/lib/utils.ts");
  });
});

describe("matchesAny", () => {
  it("matches dotfiles and nested paths", () => {
    expect(matchesAny([".botss/handoffs/**"], ".botss/handoffs/T001.md")).toBe(true);
    expect(matchesAny(["backend/**"], "backend\\app\\x.py")).toBe(true);
    expect(matchesAny(["backend/**"], "frontend/x.ts")).toBe(false);
  });
});
