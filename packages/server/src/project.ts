import { Db, DEFAULT_ALLOWED_TOOLS, LEGACY_ALLOWED_TOOLS, parseRolesYaml, type RolesFile } from "@botss/core";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EventBus } from "./bus.ts";
import { Commands } from "./commands.ts";
import { ensureWorktree, git, INTEGRATION_BRANCH } from "./git.ts";
import { isLegacyIsolated, moveToDirect } from "./migrate.ts";
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
    this.upgradeSettings();
    this.orch = new Orchestrator(this);
    this.cmds = new Commands(this);
    this.writeShims();
  }

  static async open(root: string, ctx: ProjectContext): Promise<Project> {
    const p = new Project(root, ctx);
    // Projects from before direct mode move to the owner's folder (no worktrees) the first time they open.
    if (isLegacyIsolated(p)) {
      const r = await moveToDirect(p).catch((e: Error) => ({ ok: false, message: e.message }));
      if (!r.ok) p.svc.alert(r.message);
    }
    if (!p.direct) {
      // Isolated mode works through git: the project must be the root of its own repository, or projects in
      // the same parent repository would share branches.
      const top = await git(p.paths.root, ["rev-parse", "--show-toplevel"], { reject: false });
      const norm = (x: string) => path.resolve(x).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (top.code !== 0 || norm(top.stdout.trim()) !== norm(root)) {
        p.db.close();
        throw new Error(
          `${root} is not the root of its own git repository${top.code === 0 ? ` (it is inside ${top.stdout.trim()})` : ""}. Run \`botss init\` in it again.`,
        );
      }
      await ensureWorktree(p.paths.root, p.paths.integration, INTEGRATION_BRANCH, INTEGRATION_BRANCH);
    }
    return p;
  }

  /** Direct mode (the default): agents work in the project folder itself, no git involved. */
  get direct(): boolean {
    return this.svc.settings.workspace !== "isolated";
  }

  /** Where the shared project files (and `.botss/docs`, `.botss/tasks`) live. */
  sharedDir(): string {
    return this.direct ? this.paths.root : this.paths.integration;
  }

  /**
   * Older settings: projects made before workspace modes were isolated. Ones that had not started building are
   * moved to direct mode (their docs are copied into the project's own .botss folder); the old prefix allowlist
   * of shell commands is replaced by the guard-based default.
   */
  private upgradeSettings(): void {
    const raw = JSON.parse(String(this.db.get("SELECT settings FROM project WHERE id = 1")?.settings ?? "{}")) as Record<string, unknown>;
    const patch: Partial<import("@botss/core").Settings> = {};
    if (!raw.workspace) {
      const integDocs = path.join(this.paths.integration, ".botss");
      const started = this.db.get("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'build' AND status != 'todo'")?.n > 0;
      if (fs.existsSync(integDocs) && started) patch.workspace = "isolated";
      else {
        for (const sub of ["docs", "tasks"]) {
          const from = path.join(integDocs, sub);
          const to = path.join(this.paths.botss, sub);
          if (fs.existsSync(from) && !fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
        }
        patch.workspace = "direct";
      }
    }
    if (JSON.stringify(raw.allowed_tools) === JSON.stringify(LEGACY_ALLOWED_TOOLS)) patch.allowed_tools = DEFAULT_ALLOWED_TOOLS;
    // The old default 10M-token daily cap paused agents with nothing on screen to explain it; now no Botss cap by
    // default (Claude Code's own limits still pause and resume Botss).
    if (raw.daily_token_budget === 10_000_000) patch.daily_token_budget = 0;
    if (Object.keys(patch).length) this.svc.updateSettings(patch, "botss");
  }

  serverUrl(): string {
    return this.ctx.serverUrl();
  }

  /** Skills the agents read: the project's edited copy (from the skills editor) if there is one, else the defaults. */
  skillsDir(): string {
    if (!this.direct) {
      const integ = path.join(this.paths.integration, ".botss/skills");
      if (fs.existsSync(integ)) return integ;
    }
    const local = path.join(this.paths.botss, "skills");
    return fs.existsSync(local) ? local : SKILLS_SOURCE;
  }

  /** The folder the skills editor writes to. In direct mode the defaults are copied in on the first edit. */
  editableSkillsDir(): string {
    if (!this.direct) return path.join(this.paths.integration, ".botss/skills");
    const local = path.join(this.paths.botss, "skills");
    if (!fs.existsSync(local)) fs.cpSync(SKILLS_SOURCE, local, { recursive: true });
    return local;
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
