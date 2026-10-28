import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guessPreview, previewFromNotes } from "./preview.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const mk = (files: Record<string, string>) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "botss-preview-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
};

describe("preview plans", () => {
  it("reads the tech lead's Preview section", () => {
    expect(previewFromNotes("# Codebase\n\n## Preview\n- command: `npm run dev -- --port 5173`\n- url: http://localhost:5173\n\n## Checks\n- npm test")).toEqual({
      command: "npm run dev -- --port 5173",
      url: "http://localhost:5173",
    });
    expect(previewFromNotes("# nothing here")).toBeNull();
  });

  it("guesses from project files", () => {
    expect(guessPreview(mk({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }), "pnpm-lock.yaml": "" }), 4000)?.command).toBe("pnpm install && pnpm run dev");
    expect(guessPreview(mk({ "package.json": JSON.stringify({ scripts: { start: "node s.js" } }), "node_modules/.keep": "" }), 4000)?.command).toBe("npm run start");
    expect(guessPreview(mk({ "manage.py": "" }), 4001)).toMatchObject({ command: "python manage.py runserver 127.0.0.1:4001", url: "http://127.0.0.1:4001" });
    expect(guessPreview(mk({ "index.html": "<h1>x</h1>" }), 4002)).toMatchObject({ command: null, url: "http://127.0.0.1:4002" });
    expect(guessPreview(mk({ "README.md": "" }), 4003)).toBeNull();
  });
});
