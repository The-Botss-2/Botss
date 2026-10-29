import { matchesAny } from "@botss/core";
import fs from "node:fs";
import path from "node:path";
import { git, INTEGRATION_BRANCH, removeWorktree } from "./git.ts";
import type { Project } from "./project.ts";
import { snapshotDir } from "./snapshot.ts";

// Projects created before direct mode used git worktrees (`../.botss-worktrees/...`). Owners want agents in their
// own folder, so such projects are moved over when opened: finished work (botss/integration) is merged into the
// owner's current branch, unfinished tasks bring their work along, and the worktrees are removed.

/** Projects whose config never chose a workspace were created before direct mode existed. */
export function isLegacyIsolated(p: Project): boolean {
  if (p.direct) return false;
  try {
    return !/^workspace\s*:/m.test(fs.readFileSync(p.paths.config, "utf8"));
  } catch {
    return false;
  }
}

export async function moveToDirect(p: Project): Promise<{ ok: boolean; message: string }> {
  const root = p.paths.root;
  const status = (await git(root, ["status", "--porcelain"], { reject: false })).stdout
    .split("\n")
    .filter((l) => l.trim() && !l.includes(".botss/"));
  if (status.length) {
    return {
      ok: false,
      message: `Botss wants to move ${p.paths.name} to work directly in your folder, but the folder has uncommitted changes. Commit or stash them, then restart botss up.`,
    };
  }
  const merged: string[] = [];
  // 1. Finished work.
  if ((await git(root, ["rev-parse", "--verify", "--quiet", INTEGRATION_BRANCH], { reject: false })).code === 0) {
    const r = await git(root, ["merge", "--no-edit", "-m", "botss: bring finished work into the project folder", INTEGRATION_BRANCH], { reject: false });
    if (r.code !== 0) {
      await git(root, ["merge", "--abort"], { reject: false });
      return { ok: false, message: `Could not merge ${INTEGRATION_BRANCH} into your branch automatically (${(r.stderr || r.stdout).trim().slice(0, 300)}). Merge it yourself, then restart botss up.` };
    }
    merged.push(INTEGRATION_BRANCH);
  }
  // 2. Unfinished tasks: keep a snapshot of their files as they were before their work (for "what changed"),
  // then bring their work in. A task whose work conflicts starts over.
  for (const t of p.svc.tasks({ kind: ["build", "integrate", "release"] })) {
    if (t.status === "done" || !t.branch) continue;
    const owned = [...t.owns, ...t.may_touch];
    const dir = snapshotDir(p.paths.botss, t.id);
    fs.rmSync(dir, { recursive: true, force: true });
    const files = (await git(root, ["ls-files"], { reject: false })).stdout.split("\n").filter((f) => f && matchesAny(owned, f));
    for (const f of files) {
      const to = path.join(dir, "files", f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(root, f), to);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), globs: owned, files }, null, 2));
    const r = await git(root, ["merge", "--no-edit", "-m", `botss: bring in unfinished work of ${t.id}`, t.branch], { reject: false });
    if (r.code !== 0) {
      await git(root, ["merge", "--abort"], { reject: false });
      fs.rmSync(dir, { recursive: true, force: true });
    } else merged.push(t.branch);
    // Sessions lived in the worktree folder; the next run starts fresh in the project folder.
    p.svc.updateTask(t.id, { worktree: null, branch: null, session_id: null });
    p.svc.patchMeta(t.id, { resume: null });
  }
  // 3. Remove the worktrees and the old Botss copies of skills (direct mode reads them from the install).
  const list = (await git(root, ["worktree", "list", "--porcelain"], { reject: false })).stdout;
  for (const m of list.matchAll(/^worktree (.+)$/gm)) {
    const wt = path.resolve(m[1]!.trim());
    if (wt.toLowerCase() !== path.resolve(root).toLowerCase() && wt.toLowerCase().startsWith(path.resolve(p.paths.worktrees).toLowerCase())) {
      await removeWorktree(root, wt);
    }
  }
  try {
    fs.rmSync(p.paths.worktrees, { recursive: true, force: true });
    const parent = path.dirname(p.paths.worktrees);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  } catch {
    /* best effort */
  }
  // 4. Docs and tasks now live in the project's own .botss folder (they came in with the merge, too).
  for (const sub of ["docs", "tasks"]) fs.mkdirSync(path.join(p.paths.botss, sub), { recursive: true });
  // Remember the choice so this never runs again.
  fs.appendFileSync(p.paths.config, "\nworkspace: direct\n");
  p.svc.updateSettings({ workspace: "direct" }, "botss");
  const message = `Moved ${p.paths.name} to work directly in your folder. ${merged.length ? `Brought in: ${merged.join(", ")}.` : ""} No more worktrees.`;
  p.svc.emit("project.moved", message, { merged }, { actor: "botss" });
  return { ok: true, message };
}
