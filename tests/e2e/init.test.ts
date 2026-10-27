import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, initProject } from "@botss/server";

let dir: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  dir = undefined;
});

describe("botss init", () => {
  it("gives projects inside another repository their own repository, and never commits secrets", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "botss-init-"));
    process.env.BOTSS_HOME = path.join(dir, "home");
    // A parent folder that is itself a git repo, holding several projects (like "C:\Saram Work").
    const parent = path.join(dir, "work");
    fs.mkdirSync(parent);
    await git(parent, ["init", "-q", "-b", "master"]);

    const a = path.join(parent, "project-a");
    fs.mkdirSync(a);
    const b = path.join(parent, "website");
    fs.mkdirSync(path.join(b, "src"), { recursive: true });
    fs.writeFileSync(path.join(b, "index.html"), "<h1>site</h1>");
    fs.writeFileSync(path.join(b, "src", "app.ts"), "export {};");
    fs.writeFileSync(path.join(b, "server.pem"), "-----BEGIN PRIVATE KEY-----");
    fs.writeFileSync(path.join(b, ".env"), "SECRET=1");
    fs.writeFileSync(path.join(b, ".env.example"), "SECRET=");
    fs.mkdirSync(path.join(b, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(b, "node_modules", "x", "i.js"), "");

    const ra = await initProject(a, { workspace: "isolated" });
    const rb = await initProject(b, { workspace: "isolated" });

    // Each project is the root of its own repository.
    for (const p of [a, b]) {
      expect(path.resolve((await git(p, ["rev-parse", "--show-toplevel"])).stdout.trim()).toLowerCase()).toBe(path.resolve(p).toLowerCase());
    }
    expect(ra.created.join(" ")).toMatch(/its own git repository/);
    // The parent repository is untouched: no commits, no botss branch.
    expect((await git(parent, ["rev-parse", "--verify", "--quiet", "HEAD"], { reject: false })).code).not.toBe(0);
    expect((await git(parent, ["branch", "--list", "botss/*"])).stdout.trim()).toBe("");
    // The existing code was committed, without secrets or node_modules.
    expect(rb.existing).toBe(true);
    const tracked = (await git(b, ["ls-files"])).stdout.split("\n");
    expect(tracked).toEqual(expect.arrayContaining(["index.html", "src/app.ts", ".env.example"]));
    expect(tracked).not.toContain("server.pem");
    expect(tracked).not.toContain(".env");
    expect(tracked.some((f) => f.startsWith("node_modules/"))).toBe(false);
    // Both integration worktrees exist side by side.
    expect(fs.existsSync(path.join(ra.integration, ".botss", "skills"))).toBe(true);
    expect(fs.existsSync(path.join(rb.integration, ".botss", "skills"))).toBe(true);
  });
});
