import path from "node:path";
import { matchesAny } from "./globs.ts";
import type { Role } from "./types.ts";

// Pure decision logic for the PreToolUse guard hook. The CLI wrapper (`botss hook pre-tool-use`) gathers the
// context, resolves symlinks with the real filesystem, and exits 2 with the reason when this denies.

export interface GuardContext {
  role: Role;
  agent: string;
  /** Absolute worktree path the agent works in. */
  worktree: string;
  /** Globs (relative to the worktree) the agent may write: task owns + may_touch + role writes + scratch. */
  writable: string[];
  /** The task branch, e.g. botss/T012-orders-list. */
  branch: string;
  composeProject: string;
  homeDir: string;
  allowNetwork?: boolean;
  /** Integrate tasks may `git merge` task branches into their own branch. */
  allowMerge?: boolean;
  /** Resolve symlinks of an absolute path (deepest existing ancestor). Defaults to identity. */
  realpath?: (p: string) => string;
}

export interface ToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
}

export interface GuardResult {
  allow: boolean;
  reason?: string;
}

const PROTECTED_BRANCHES = ["main", "master", "botss/integration", "develop", "trunk"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "host.docker.internal"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);

const allow = (): GuardResult => ({ allow: true });
const deny = (reason: string): GuardResult => ({ allow: false, reason: `Botss guard: ${reason}` });

function norm(p: string): string {
  // Compare case-insensitively on Windows-style paths so C:\X and c:\x are the same.
  const n = path.resolve(p).replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(n) ? n[0]!.toLowerCase() + n.slice(1) : n;
}

function inside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

function isCredentialPath(abs: string, home: string): boolean {
  const n = norm(abs);
  const h = norm(home);
  if (inside(n, `${h}/.claude`) || n === `${h}/.claude.json`) return true;
  return /\/\.credentials\.json$/.test(n) || /\/\.anthropic(\/|$)/.test(n) || /\/\.aws\/credentials$/.test(n);
}

export function guardDecision(call: ToolCall, ctx: GuardContext): GuardResult {
  const real = ctx.realpath ?? ((p: string) => p);
  const cwd = call.cwd ?? ctx.worktree;
  const input = call.tool_input ?? {};

  if (WRITE_TOOLS.has(call.tool_name)) {
    const raw = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    if (!raw) return deny(`${call.tool_name} without a file path`);
    const abs = real(path.resolve(cwd, raw));
    if (isCredentialPath(abs, ctx.homeDir)) return deny("credential files are off limits");
    const wt = real(path.resolve(ctx.worktree));
    if (!inside(abs, wt)) return deny(`${raw} is outside your worktree (${ctx.worktree}). Write only inside your worktree.`);
    const rel = path.relative(wt, abs).replace(/\\/g, "/");
    if (rel === ".git" || rel.startsWith(".git/")) return deny("never write inside .git");
    if (rel.endsWith("botss.db") || rel.includes(".botss/botss.db")) return deny("never write .botss/botss.db; use the botss CLI");
    if (ctx.role === "reviewer") {
      if (rel.startsWith(".botss/reviews/")) return allow();
      return deny(`the reviewer is read only; write review files under .botss/reviews/ only (tried ${rel})`);
    }
    if (!matchesAny(ctx.writable, rel)) {
      return deny(
        `${rel} is not in this task's owned paths. Allowed: ${ctx.writable.join(", ")}. ` +
          `If you must change it, message its owner or the tech lead (botss ask @tech-lead).`,
      );
    }
    return allow();
  }

  if (READ_TOOLS.has(call.tool_name)) {
    const raw = String(input.file_path ?? input.path ?? input.notebook_path ?? "");
    if (raw && isCredentialPath(real(path.resolve(cwd, raw)), ctx.homeDir)) return deny("credential files are off limits");
    return allow();
  }

  if (call.tool_name === "Bash") {
    return checkBash(String(input.command ?? ""), { ...ctx, worktree: ctx.worktree }, cwd);
  }
  return allow();
}

// ---------------------------------------------------------------------------------------------------------
// Bash

/** Split a command line into simple commands (on ; && || | & and newlines) and shell words, honoring quotes. */
export function splitCommands(cmd: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  const pushWord = () => {
    if (has) words.push(cur);
    cur = "";
    has = false;
  };
  const pushCmd = () => {
    pushWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "&") {
      pushCmd();
      continue;
    }
    if (c === "(" || c === ")" || c === "`") {
      pushCmd();
      continue;
    }
    if (c === "$" && cmd[i + 1] === "(") {
      pushCmd();
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      pushWord();
      continue;
    }
    cur += c;
    has = true;
  }
  pushCmd();
  return commands;
}

/** Drop leading VAR=value assignments and wrappers like `sudo`, `env`, `command`, `exec`, `time`, `nohup`. */
function stripPrefix(words: string[]): { env: Record<string, string>; argv: string[] } {
  const env: Record<string, string> = {};
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i]!;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(w);
    if (m) {
      env[m[1]!] = m[2]!;
      continue;
    }
    if (["sudo", "env", "command", "exec", "time", "nohup", "nice", "xargs"].includes(w)) continue;
    break;
  }
  return { env, argv: words.slice(i) };
}

function base(cmd: string): string {
  return cmd.replace(/\\/g, "/").split("/").pop()!.replace(/\.exe$/i, "");
}

function checkBash(command: string, ctx: GuardContext, cwd: string): GuardResult {
  const home = norm(ctx.homeDir);
  // Credential reads anywhere in the line, before any parsing tricks.
  const credPatterns = [
    /(^|[\s"'=:])(~|\$HOME|\$\{HOME\}|%USERPROFILE%)[\\/]+\.claude(\.json)?\b/,
    /\.credentials\.json/,
    /security\s+find-(generic|internet)-password/,
    /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/,
  ];
  if (credPatterns.some((r) => r.test(command)) || command.replace(/\\/g, "/").toLowerCase().includes(`${home.toLowerCase()}/.claude`)) {
    return deny("reading Claude credentials or config (~/.claude) is never allowed");
  }
  if (/botss\.db\b/.test(command)) return deny("never touch .botss/botss.db; the botss CLI is the only writer of board state");

  for (const words of splitCommands(command)) {
    const { env, argv } = stripPrefix(words);
    if (argv.length === 0) continue;
    const prog = base(argv[0]!);
    const args = argv.slice(1);
    let r: GuardResult = allow();
    if (prog === "git") r = checkGit(args, ctx);
    else if (prog === "rm") r = checkRm(args, ctx, cwd);
    else if (prog === "docker" || prog === "docker-compose") r = checkDocker(prog === "docker-compose" ? ["compose", ...args] : args, env, ctx);
    else if (prog === "curl" || prog === "wget") r = checkNet(prog, args, ctx);
    else if (["sh", "bash", "zsh", "dash"].includes(prog)) {
      const i = args.indexOf("-c");
      if (i >= 0 && args[i + 1]) r = checkBash(args[i + 1]!, ctx, cwd);
    }
    if (!r.allow) return r;
  }
  return allow();
}

function checkGit(args0: string[], ctx: GuardContext): GuardResult {
  // Skip global options like -C <dir>, -c k=v, --no-pager.
  const args = [...args0];
  while (args.length && args[0]!.startsWith("-")) {
    const opt = args.shift()!;
    if ((opt === "-C" || opt === "-c") && args.length) args.shift();
  }
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "push": {
      if (rest.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--mirror" || a === "--delete" || a === "-d" || a === "--all"))
        return deny("git push --force / --delete / --mirror / --all is never allowed");
      const positional = rest.filter((a) => !a.startsWith("-"));
      const refs = positional.slice(1);
      for (const ref of refs) {
        if (ref.startsWith("+")) return deny("force-push refspecs (+ref) are never allowed");
        const dst = ref.includes(":") ? ref.split(":")[1]! : ref;
        const short = dst.replace(/^refs\/heads\//, "");
        if (short !== ctx.branch && short !== "HEAD") return deny(`you may only push your task branch ${ctx.branch}, not ${short}`);
      }
      return allow();
    }
    case "merge":
      if (ctx.allowMerge && !rest.some((a) => PROTECTED_BRANCHES.includes(a))) return allow();
      if (ctx.allowMerge) return deny("integration tasks merge task branches into their own branch only");
      return deny("agents never run git merge; the orchestrator merges finished tasks");
    case "rebase":
      if (rest.some((a) => PROTECTED_BRANCHES.includes(a) && rest.indexOf(a) > 0) || rest.includes("--onto"))
        return deny("rebasing shared branches is not allowed");
      return allow();
    case "worktree":
      if (rest[0] === "remove" || rest[0] === "prune" || rest[0] === "move") return deny("never remove or move worktrees; the orchestrator manages them");
      return allow();
    case "branch":
      if (rest.some((a) => a === "-D" || a === "-d" || a === "--delete" || a === "-M" || a === "-m" || a === "--force" || a === "-f"))
        return deny("deleting, renaming, or force-moving branches is not allowed");
      return allow();
    case "checkout":
    case "switch":
      if (rest.some((a) => PROTECTED_BRANCHES.includes(a))) return deny(`stay on your task branch ${ctx.branch}; do not check out shared branches`);
      return allow();
    case "reset":
      if (rest.some((a) => PROTECTED_BRANCHES.includes(a) || /^origin\//.test(a))) return deny("do not reset to shared branches");
      return allow();
    case "update-ref":
    case "filter-branch":
    case "replace":
      return deny(`git ${sub} rewrites refs and is not allowed`);
    case "clean":
      return allow();
    default:
      return allow();
  }
}

function checkRm(args: string[], ctx: GuardContext, cwd: string): GuardResult {
  const flags = args.filter((a) => a.startsWith("-")).join("");
  const recursive = /r|R|--recursive/.test(flags);
  const targets = args.filter((a) => !a.startsWith("-"));
  const wt = (ctx.realpath ?? ((p: string) => p))(path.resolve(ctx.worktree));
  for (const t of targets) {
    if (/^(~|\$HOME|\$\{HOME\}|\/|\*|\.\.)$/.test(t) || t.startsWith("~") || t.startsWith("$")) {
      return deny(`rm of ${t} is outside your worktree`);
    }
    const abs = (ctx.realpath ?? ((p: string) => p))(path.resolve(cwd, t));
    if (!inside(abs, wt)) return deny(`rm ${recursive ? "-r " : ""}of ${t} is outside your worktree`);
    if (recursive && norm(abs) === norm(wt)) return deny("never delete your whole worktree");
    const rel = path.relative(wt, abs).replace(/\\/g, "/");
    if (rel === ".git" || rel.startsWith(".git/")) return deny("never delete .git");
  }
  return allow();
}

function checkDocker(args: string[], env: Record<string, string>, ctx: GuardContext): GuardResult {
  const own = ctx.composeProject;
  if (args[0] === "compose") {
    let project = env.COMPOSE_PROJECT_NAME;
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if ((a === "-p" || a === "--project-name") && args[i + 1]) project = args[i + 1];
      else if (a.startsWith("--project-name=")) project = a.split("=")[1];
    }
    const destructive =
      args.includes("down") && args.some((a) => a === "-v" || a === "--volumes" || a === "--rmi");
    if (destructive && project !== undefined && project !== own) {
      return deny(`docker compose down -v on project ${project} would wipe another stack; your project is ${own}`);
    }
    if (project !== undefined && project !== own && (args.includes("rm") || args.includes("kill") || args.includes("down"))) {
      return deny(`you may only manage your own compose project ${own}`);
    }
    return allow();
  }
  if (args[0] === "volume" && (args[1] === "rm" || args[1] === "prune")) {
    if (args[1] === "prune") return deny("docker volume prune affects every stack; not allowed");
    const names = args.slice(2).filter((a) => !a.startsWith("-"));
    const bad = names.find((n) => !n.startsWith(`${own}_`));
    if (bad || names.length === 0) return deny(`docker volume rm ${bad ?? ""} is not one of your stack's volumes (${own}_*)`);
    return allow();
  }
  if (args[0] === "system" && args[1] === "prune") return deny("docker system prune affects every stack; not allowed");
  if ((args[0] === "rm" || args[0] === "kill" || args[0] === "stop") && args.length > 1) {
    const names = args.slice(1).filter((a) => !a.startsWith("-"));
    const bad = names.find((n) => !n.startsWith(own));
    if (bad) return deny(`container ${bad} is not part of your stack (${own})`);
  }
  return allow();
}

function hostOf(arg: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:?#@]+@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(arg);
  if (m) return (m[2] ?? "").toLowerCase();
  if (/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(arg)) return arg.split(/[:/]/)[0]!.toLowerCase();
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(arg)) return arg.split(/[:/]/)[0]!.toLowerCase();
  return null;
}

function checkNet(prog: string, args: string[], ctx: GuardContext): GuardResult {
  if (ctx.allowNetwork) return allow();
  for (const a of args) {
    if (a.startsWith("-")) continue;
    const h = hostOf(a);
    if (h && !LOCAL_HOSTS.has(h)) return deny(`${prog} to ${h} is blocked: agents may only call localhost unless the task allows network access`);
  }
  return allow();
}
