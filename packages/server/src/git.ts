import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";

export const INTEGRATION_BRANCH = "botss/integration";

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  // Git for Windows asks "Deletion of directory failed. Should I try again? (y/n)" on locked files; never wait.
  GIT_ASK_YESNO: "false",
  GIT_AUTHOR_NAME: "Botss",
  GIT_AUTHOR_EMAIL: "botss@localhost",
  GIT_COMMITTER_NAME: "Botss",
  GIT_COMMITTER_EMAIL: "botss@localhost",
};

export async function git(cwd: string, args: string[], opts: { reject?: boolean; env?: Record<string, string> } = {}) {
  const r = await execa("git", args, { cwd, reject: false, env: { ...GIT_ENV, ...opts.env }, stripFinalNewline: true, stdin: "ignore", timeout: 120_000 });
  if (opts.reject !== false && r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr || r.stdout}`);
  }
  return { code: r.exitCode ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

export async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--git-dir"], { reject: false })).code === 0;
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { reject: false })).code === 0;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { reject: false })).code === 0;
}

/** Files tracked at HEAD (for the conservative collision check). */
export async function lsFiles(cwd: string): Promise<string[]> {
  const r = await git(cwd, ["ls-files"], { reject: false });
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export async function statusPorcelain(cwd: string): Promise<{ code: string; file: string }[]> {
  const r = await git(cwd, ["status", "--porcelain=v1", "-uall"]);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      let file = l.slice(3);
      if (file.includes(" -> ")) file = file.split(" -> ")[1]!;
      return { code: l.slice(0, 2), file: file.replace(/^"|"$/g, "") };
    });
}

/** Add (or reuse) a worktree on `branch`, creating the branch from `from` if needed. */
export async function ensureWorktree(repo: string, dir: string, branch: string, from: string): Promise<{ created: boolean }> {
  if (fs.existsSync(path.join(dir, ".git"))) return { created: false };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, ["worktree", "prune"], { reject: false });
  if (await branchExists(repo, branch)) {
    await git(repo, ["worktree", "add", dir, branch]);
  } else {
    await git(repo, ["worktree", "add", "-b", branch, dir, from]);
  }
  return { created: true };
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  await git(repo, ["worktree", "remove", "--force", dir], { reject: false });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await git(repo, ["worktree", "prune"], { reject: false });
}

export async function diffStat(cwd: string, base: string, head = "HEAD"): Promise<string> {
  return (await git(cwd, ["diff", "--stat", `${base}...${head}`], { reject: false })).stdout;
}

export async function diffNames(cwd: string, base: string, head = "HEAD"): Promise<string[]> {
  return (await git(cwd, ["diff", "--name-only", `${base}...${head}`], { reject: false })).stdout.split("\n").filter(Boolean);
}

export async function commitAll(cwd: string, message: string, paths: string[] = ["-A"]): Promise<boolean> {
  await git(cwd, ["add", ...paths]);
  const st = await git(cwd, ["diff", "--cached", "--quiet"], { reject: false });
  if (st.code === 0) return false;
  await git(cwd, ["commit", "-m", message, "--no-verify"]);
  return true;
}
