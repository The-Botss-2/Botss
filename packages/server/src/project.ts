import { Db, parseRolesYaml, type RolesFile } from "@botss/core";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "./bus.ts";
import { Commands } from "./commands.ts";
import { ensureWorktree, git, INTEGRATION_BRANCH } from "./git.ts";
import { Orchestrator } from "./orchestrator.ts";
import { CLI_ENTRY, NODE_FLAGS, ProjectPaths, ROLES_SOURCE, SKILLS_SOURCE } from "./paths.ts";
import { ClaudeRunner, type AgentRunner } from "./runner.ts";
import { ProjectService } from "./service.ts";
import type { TokenStore } from "./tokens.ts";

export function projectId(root: string): string {
  const norm = path.resolve(root).replace(/\\/g, "/").toLowerCase();
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 10);
}

export interface ProjectContext {
  bus: EventBus;
  tokens: TokenStore;
  serverUrl: () => string;
  runner?: AgentRunner;
}

export class Project {
  readonly id: string;
  readonly paths: ProjectPaths;
  readonly db: Db;
  readonly svc: ProjectService;
  readonly roles: RolesFile;
  readonly runner: AgentRunner;
  readonly orch: Orchestrator;
  readonly cmds: Commands;
  readonly tokens: TokenStore;
  private readonly ctx: ProjectContext;

  private constructor(root: string, ctx: ProjectContext) {
    this.ctx = ctx;
    this.paths = new ProjectPaths(path.resolve(root));
    this.id = projectId(this.paths.root);
    if (!fs.existsSync(this.paths.botss)) throw new Error(`${this.paths.root} is not a Botss project. Run \`botss init ${this.paths.root}\` first.`);
    fs.mkdirSync(this.paths.runs, { recursive: true });
    this.db = new Db(this.paths.db);
    this.svc = new ProjectService(this.id, this.db, ctx.bus);
    this.svc.ensureProject(this.paths.name, this.paths.root, this.paths.config);
    const rolesFile = fs.existsSync(path.join(this.paths.botss, "roles.yaml")) ? path.join(this.paths.botss, "roles.yaml") : ROLES_SOURCE;
    this.roles = parseRolesYaml(fs.readFileSync(rolesFile, "utf8"));
    this.runner = ctx.runner ?? new ClaudeRunner();
    this.tokens = ctx.tokens;
    this.orch = new Orchestrator(this);
    this.cmds = new Commands(this);
    this.writeShims();
  }

  static async open(root: string, ctx: ProjectContext): Promise<Project> {
    // Refuse projects that live inside someone else's repository (made by older Botss versions): they would
    // share branches with every other project in that repository.
    const top = await git(path.resolve(root), ["rev-parse", "--show-toplevel"], { reject: false });
    const norm = (x: string) => path.resolve(x).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (top.code !== 0 || norm(top.stdout.trim()) !== norm(root)) {
      throw new Error(
        `${root} is not the root of its own git repository${top.code === 0 ? ` (it is inside ${top.stdout.trim()})` : ""}. Run \`botss init\` in it again to give it its own repository.`,
      );
    }
    const p = new Project(root, ctx);
    await ensureWorktree(p.paths.root, p.paths.integration, INTEGRATION_BRANCH, INTEGRATION_BRANCH);
    return p;
  }

  serverUrl(): string {
    return this.ctx.serverUrl();
  }

  /** Skills the agents read: the committed copy on the integration branch (edited by the skills editor). */
  skillsDir(): string {
    const integ = path.join(this.paths.integration, ".botss/skills");
    if (fs.existsSync(integ)) return integ;
    const local = path.join(this.paths.botss, "skills");
    return fs.existsSync(local) ? local : SKILLS_SOURCE;
  }

  /** `botss` on the agents' PATH: a POSIX shim (Git Bash on Windows too) and a .cmd shim. */
  private writeShims(): void {
    fs.mkdirSync(this.paths.bin, { recursive: true });
    const node = process.execPath;
    const flags = NODE_FLAGS.join(" ");
    const posixNode = node.replace(/\\/g, "/");
    const posixCli = CLI_ENTRY.replace(/\\/g, "/");
    fs.writeFileSync(path.join(this.paths.bin, "botss"), `#!/bin/sh\nexec "${posixNode}" ${flags} "${posixCli}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(this.paths.bin, "botss.cmd"), `@echo off\r\n"${node}" ${flags} "${CLI_ENTRY}" %*\r\n`);
  }

  start(): void {
    this.orch.start();
  }

  async close(): Promise<void> {
    await this.orch.stop();
    this.orch.closed = true;
    this.db.close();
  }
}
