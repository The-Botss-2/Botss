import { matchesAny } from "@botss/core";
import { createTwoFilesPatch } from "diff";
import fs from "node:fs";
import path from "node:path";

// Direct mode has no git, so "what did this task change?" comes from a copy of the task's files taken when its
// first run starts. Only files matching the task's owned paths are copied, so the copy stays small.

const SKIP_DIRS = new Set([".git", ".botss", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".turbo", "coverage", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
const MAX_FILES = 50_000;
const MAX_DIFF_BYTES = 200_000;

/** Project files (relative, forward slashes), skipping dependencies, build output, and Botss's own folder. */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r);
      } else if (e.isFile()) out.push(r);
    }
  };
  walk(root, "");
  return out;
}

export function snapshotDir(botssDir: string, taskId: string): string {
  return path.join(botssDir, "snapshots", taskId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Copy the task's current files aside once (on the task's first run). */
export function takeSnapshot(root: string, globs: string[], dir: string): void {
  if (fs.existsSync(path.join(dir, "manifest.json"))) return;
  const files = walkFiles(root).filter((f) => matchesAny(globs, f));
  for (const f of files) {
    const to = path.join(dir, "files", f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, f), to);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), globs, files }, null, 2));
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

/** Files under the task's paths that differ from the snapshot. */
export function changedFiles(root: string, globs: string[], dir: string): FileChange[] {
  const manifestFile = path.join(dir, "manifest.json");
  const before = new Set<string>(fs.existsSync(manifestFile) ? (JSON.parse(fs.readFileSync(manifestFile, "utf8")).files as string[]) : []);
  const now = walkFiles(root).filter((f) => matchesAny(globs, f));
  const out: FileChange[] = [];
  for (const f of now) {
    if (!before.has(f)) out.push({ path: f, status: "added" });
    else if (!fs.readFileSync(path.join(root, f)).equals(fs.readFileSync(path.join(dir, "files", f)))) out.push({ path: f, status: "modified" });
  }
  const nowSet = new Set(now);
  for (const f of before) if (!nowSet.has(f)) out.push({ path: f, status: "deleted" });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A unified diff of the task's changes (like `git diff`), for review and the dashboard. */
export function snapshotDiff(root: string, globs: string[], dir: string): { files: FileChange[]; diff: string; stat: string } {
  const files = changedFiles(root, globs, dir);
  const read = (p: string) => {
    try {
      const b = fs.readFileSync(p);
      if (b.length > MAX_DIFF_BYTES || b.includes(0)) return null;
      return b.toString("utf8");
    } catch {
      return "";
    }
  };
  const parts: string[] = [];
  const stat: string[] = [];
  for (const c of files) {
    const oldText = c.status === "added" ? "" : read(path.join(dir, "files", c.path));
    const newText = c.status === "deleted" ? "" : read(path.join(root, c.path));
    if (oldText === null || newText === null) {
      parts.push(`diff --git a/${c.path} b/${c.path}\nBinary or large file ${c.status}\n`);
      stat.push(` ${c.path} | ${c.status} (binary or large)`);
      continue;
    }
    const patch = createTwoFilesPatch(c.status === "added" ? "/dev/null" : `a/${c.path}`, c.status === "deleted" ? "/dev/null" : `b/${c.path}`, oldText, newText, "", "", { context: 3 });
    // Drop the "===" header line createTwoFilesPatch adds; keep a git-style header for diff viewers.
    parts.push(`diff --git a/${c.path} b/${c.path}\n${patch.split("\n").filter((l) => !l.startsWith("====")).join("\n")}`);
    const plus = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const minus = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    stat.push(` ${c.path} | ${c.status} +${plus} -${minus}`);
  }
  return { files, diff: parts.join("\n"), stat: stat.join("\n") || " (no changes)" };
}
