import { initialConfigYaml, parseRolesYaml } from "@botss/core";
import fs from "node:fs";
import path from "node:path";
import { branchExists, commitAll, ensureWorktree, git, hasCommits, INTEGRATION_BRANCH } from "./git.ts";
import { ProjectPaths, ROLES_SOURCE, SKILLS_SOURCE } from "./paths.ts";
import { addToRegistry } from "./registry.ts";

const EXCLUDES = [
  "# botss (local state, never committed)",
  ".botss/botss.db",
  ".botss/botss.db-*",
  ".botss/runs/",
  ".botss/bin/",
  ".botss/attachments/",
  ".botss/config.yaml",
  ".botss/roles.yaml",
  ".botss/handoffs/",
  ".botss/reviews/",
  ".botss/screens/",
];

const GITIGNORE_BLOCK = [
  "",
  "# Botss: local state and scratch areas (never committed)",
  ".botss/botss.db*",
  ".botss/runs/",
  ".botss/bin/",
  ".botss/attachments/",
  ".botss/config.yaml",
  ".botss/roles.yaml",
  ".botss/handoffs/",
  ".botss/reviews/",
  ".botss/screens/",
  "",
];

export interface InitResult {
  root: string;
  created: string[];
  integration: string;
  alreadyInitialized: boolean;
  existing: boolean;
  warnings: string[];
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** Never committed when Botss adopts an existing folder: secrets, and folders that are rebuilt anyway. */
const SECRET_AND_HEAVY = [
  "# botss: never commit secrets or build output",
  ".env",
  ".env.*",
  "!.env.example",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "id_rsa*",
  "id_ed25519*",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "dist/",
  "build/",
  ".next/",
];

function samePath(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

export async function initProject(root0: string, opts: { skillsSource?: string; rolesSource?: string } = {}): Promise<InitResult> {
  const root = path.resolve(root0);
  const paths = new ProjectPaths(root);
  const created: string[] = [];
  fs.mkdirSync(root, { recursive: true });
  const already = fs.existsSync(paths.botss) && fs.existsSync(paths.config);
  // An existing codebase: the folder already has files (other than dotfiles and Botss's own).
  const existing = fs.readdirSync(root).some((n) => !n.startsWith("."));
  const warnings: string[] = [];

  // Every Botss project is its own repository. A folder that merely sits inside another repository (for
  // example a projects folder that is itself a git repo) gets a nested repo of its own, so projects never
  // share branches and Botss never commits into the parent repo.
  const top = await git(root, ["rev-parse", "--show-toplevel"], { reject: false });
  const isOwnRepo = top.code === 0 && samePath(top.stdout.trim(), root);
  if (!isOwnRepo) {
    await git(root, ["init", "-b", "main"]);
    created.push(top.code === 0 ? `its own git repository (the folder was inside ${top.stdout.trim()}, which Botss leaves alone)` : "git repository");
  }
  if (!(await hasCommits(root))) {
    if (existing) {
      // Agents work from git, so the existing code must be in the first commit. Secrets and heavy folders
      // stay out (even when the project's .gitignore forgets them).
      const ex = path.join(root, ".git", "info", "exclude");
      fs.mkdirSync(path.dirname(ex), { recursive: true });
      fs.appendFileSync(ex, `\n${SECRET_AND_HEAVY.join("\n")}\n`);
      await git(root, ["add", "-A", "--", ".", ":(exclude).botss"]);
      await git(root, ["commit", "--allow-empty", "-m", "Initial commit (existing code, added by botss init)"]);
      created.push("initial commit of your existing code");
    } else {
      await git(root, ["commit", "--allow-empty", "-m", "Initial commit"]);
      created.push("initial commit");
    }
  } else if ((await git(root, ["status", "--porcelain"])).stdout.trim()) {
    warnings.push("You have uncommitted changes. Agents start from your last commit, so commit what they should see.");
  }

  // Local state in the main checkout (excluded from git via .git/info/exclude, so the owner's branch is untouched).
  for (const d of [paths.botss, paths.runs, paths.attachments, paths.bin]) fs.mkdirSync(d, { recursive: true });
  const rolesText = fs.readFileSync(opts.rolesSource ?? ROLES_SOURCE, "utf8");
  if (!fs.existsSync(path.join(paths.botss, "roles.yaml"))) fs.writeFileSync(path.join(paths.botss, "roles.yaml"), rolesText);
  if (!fs.existsSync(paths.config)) {
    fs.writeFileSync(paths.config, initialConfigYaml(parseRolesYaml(rolesText), { existing }));
    created.push(".botss/config.yaml");
  }
  const commonDir = (await git(root, ["rev-parse", "--git-common-dir"])).stdout.trim();
  const exclude = path.resolve(root, commonDir, "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
  const missing = EXCLUDES.filter((l) => !cur.split(/\r?\n/).includes(l));
  if (missing.length) fs.appendFileSync(exclude, `${cur.endsWith("\n") || !cur ? "" : "\n"}${missing.join("\n")}\n`);

  // The integration branch carries everything agents share: skills, docs, tasks.
  if (!(await branchExists(root, INTEGRATION_BRANCH))) {
    await git(root, ["branch", INTEGRATION_BRANCH, "HEAD"]);
    created.push(`branch ${INTEGRATION_BRANCH}`);
  }
  await ensureWorktree(root, paths.integration, INTEGRATION_BRANCH, INTEGRATION_BRANCH);
  const integ = paths.integration;
  const skillsDst = path.join(integ, ".botss/skills");
  if (!fs.existsSync(skillsDst)) {
    copyDir(opts.skillsSource ?? SKILLS_SOURCE, skillsDst);
    created.push(".botss/skills");
  }
  for (const d of [".botss/docs", ".botss/tasks", ".botss/docs/decisions", ".botss/docs/contracts"]) {
    const full = path.join(integ, d);
    fs.mkdirSync(full, { recursive: true });
    if (!fs.readdirSync(full).length) fs.writeFileSync(path.join(full, ".gitkeep"), "");
  }
  const gi = path.join(integ, ".gitignore");
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (!giText.includes(".botss/handoffs/")) fs.writeFileSync(gi, giText + GITIGNORE_BLOCK.join("\n"));
  if (await commitAll(integ, "botss: initialize project (skills, docs, tasks)")) created.push("integration commit");

  addToRegistry(root);
  return { root, created, integration: integ, alreadyInitialized: already, existing, warnings };
}
