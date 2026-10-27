import { initialConfigYaml, parseRolesYaml } from "@botss/core";
import fs from "node:fs";
import path from "node:path";
import { branchExists, commitAll, ensureWorktree, git, hasCommits, INTEGRATION_BRANCH, isRepo } from "./git.ts";
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

export async function initProject(root0: string, opts: { skillsSource?: string; rolesSource?: string } = {}): Promise<InitResult> {
  const root = path.resolve(root0);
  const paths = new ProjectPaths(root);
  const created: string[] = [];
  fs.mkdirSync(root, { recursive: true });
  const already = fs.existsSync(paths.botss) && fs.existsSync(paths.config);

  if (!(await isRepo(root))) {
    await git(root, ["init", "-b", "main"]);
    created.push("git repository");
  }
  if (!(await hasCommits(root))) {
    await git(root, ["commit", "--allow-empty", "-m", "Initial commit"]);
    created.push("initial commit");
  }

  // Local state in the main checkout (excluded from git via .git/info/exclude, so the owner's branch is untouched).
  for (const d of [paths.botss, paths.runs, paths.attachments, paths.bin]) fs.mkdirSync(d, { recursive: true });
  const rolesText = fs.readFileSync(opts.rolesSource ?? ROLES_SOURCE, "utf8");
  if (!fs.existsSync(path.join(paths.botss, "roles.yaml"))) fs.writeFileSync(path.join(paths.botss, "roles.yaml"), rolesText);
  if (!fs.existsSync(paths.config)) {
    fs.writeFileSync(paths.config, initialConfigYaml(parseRolesYaml(rolesText)));
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
  return { root, created, integration: integ, alreadyInitialized: already };
}
