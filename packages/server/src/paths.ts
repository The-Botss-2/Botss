import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the Botss installation (the cloned repo). */
export const BOTSS_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const CLI_ENTRY = path.join(BOTSS_REPO, "packages/cli/src/main.ts");
export const DASHBOARD_DIST = path.join(BOTSS_REPO, "packages/dashboard/dist");
export const SKILLS_SOURCE = path.join(BOTSS_REPO, "skills");
export const ROLES_SOURCE = path.join(BOTSS_REPO, "roles.yaml");

/** Per-user Botss state (registry of projects, server info). Never inside ~/.claude. */
export function botssHome(): string {
  const h = process.env.BOTSS_HOME ?? path.join(os.homedir(), ".botss");
  fs.mkdirSync(h, { recursive: true });
  return h;
}

/** Node flags for every Botss-owned Node process. */
export const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];

/** Command line that runs the botss CLI (used for hooks and agent PATH shims). */
export function cliCommand(): string[] {
  return [process.execPath, ...NODE_FLAGS, CLI_ENTRY];
}

export function quoteArg(a: string): string {
  return /^[A-Za-z0-9_\-./:=@]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`;
}

export class ProjectPaths {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  get name(): string {
    return path.basename(this.root);
  }
  get botss(): string {
    return path.join(this.root, ".botss");
  }
  get db(): string {
    return path.join(this.botss, "botss.db");
  }
  get config(): string {
    return path.join(this.botss, "config.yaml");
  }
  get runs(): string {
    return path.join(this.botss, "runs");
  }
  get attachments(): string {
    return path.join(this.botss, "attachments");
  }
  get bin(): string {
    return path.join(this.botss, "bin");
  }
  /** Worktrees live next to the project: <parent>/.botss-worktrees/<project>/<name>. */
  get worktrees(): string {
    return path.join(path.dirname(this.root), ".botss-worktrees", this.name);
  }
  get integration(): string {
    return path.join(this.worktrees, "_integration");
  }
  run(id: string): string {
    return path.join(this.runs, id);
  }
}
