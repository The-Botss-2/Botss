import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { flag, type Parsed } from "./args.ts";
import { CliError, connect, findProjectRoot, projectIdFor, readServerInfo, request } from "./client.ts";

// Owner commands: init, doctor, up, status, pause, resume, stop, logs.

const MIN_NODE = [22, 18];
const MIN_CLAUDE = [2, 1];

function versionAtLeast(v: string, min: number[]): boolean {
  const parts = (/(\d+)\.(\d+)(?:\.(\d+))?/.exec(v) ?? []).slice(1).map((x) => Number(x ?? 0));
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) > min[i]!) return true;
    if ((parts[i] ?? 0) < min[i]!) return false;
  }
  return true;
}

function probe(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", timeout: 20_000, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  optional?: boolean;
}

export async function doctorChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const nodeV = process.versions.node;
  checks.push({ name: "node", ok: versionAtLeast(nodeV, MIN_NODE), detail: `v${nodeV}`, fix: "Install Node.js 22.18 or newer (https://nodejs.org)." });
  const pnpm = probe("pnpm", ["--version"]);
  const corepack = pnpm.ok ? pnpm : probe("corepack", ["pnpm", "--version"]);
  checks.push({ name: "pnpm", ok: corepack.ok, detail: pnpm.ok ? pnpm.out : corepack.ok ? `${corepack.out} (via corepack)` : "not found", fix: "Run `corepack enable` (ships with Node), or install pnpm." });
  const gitV = probe("git", ["--version"]);
  checks.push({ name: "git", ok: gitV.ok && versionAtLeast(gitV.out, [2, 20]), detail: gitV.out || "not found", fix: "Install git 2.20+ (worktree support)." });
  const docker = probe("docker", ["--version"]);
  const compose = probe("docker", ["compose", "version"]);
  checks.push({ name: "docker + compose", ok: docker.ok && compose.ok, detail: docker.ok ? `${docker.out}; ${compose.out.split("\n")[0]}` : "not found", fix: "Install Docker Desktop or Docker Engine with the compose plugin. Agents use it for per-agent databases.", optional: true });
  const uv = probe("uv", ["--version"]);
  checks.push({ name: "uv", ok: uv.ok, detail: uv.ok ? uv.out : "not found", fix: "Install uv (https://docs.astral.sh/uv/) for the Python backend of apps Botss builds.", optional: true });
  const claudeBin = process.env.BOTSS_CLAUDE_BIN ?? "claude";
  const claude = probe(claudeBin, ["--version"]);
  checks.push({
    name: "claude (Claude Code)",
    ok: claude.ok && versionAtLeast(claude.out, MIN_CLAUDE),
    detail: claude.ok ? claude.out : "not found",
    fix: "Install Claude Code (https://docs.claude.com/en/docs/claude-code) and run `claude` once to log in with your own account.",
  });
  const { portFree } = await import("@botss/server");
  const free = await portFree(4800);
  checks.push({ name: "port 4800", ok: free, detail: free ? "free" : "in use", fix: "Use `botss up --port <n>`.", optional: true });
  return checks;
}

async function doctor(p: Parsed): Promise<number> {
  const checks = await doctorChecks();
  let bad = 0;
  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.optional ? "warn" : "FAIL";
    if (!c.ok && !c.optional) bad++;
    console.log(`[${mark}] ${c.name.padEnd(22)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`       → ${c.fix}`);
  }
  if (p.flags.login) {
    console.log("\nChecking that `claude` is logged in sends one tiny prompt and uses a little of your quota.");
    let go = Boolean(p.flags.yes);
    if (!go && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      go = /^y/i.test(await rl.question("Run it? [y/N] "));
      rl.close();
    }
    if (go) {
      const r = spawnSync(process.env.BOTSS_CLAUDE_BIN ?? "claude", ["-p", "Reply with the single word: ok", "--max-turns", "1", "--output-format", "json"], {
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout: 120_000,
      });
      const ok = r.status === 0 && /"is_error"\s*:\s*false/.test(r.stdout ?? "");
      console.log(ok ? "[ok  ] claude login            works" : `[FAIL] claude login            ${(r.stdout || r.stderr || "").slice(0, 300)}\n       → Run \`claude\` and log in.`);
      if (!ok) bad++;
    } else console.log("Skipped. Run `claude` yourself once to confirm you are logged in.");
  } else {
    console.log("\nTip: `botss doctor --login` also confirms `claude` is logged in (sends one tiny prompt; asks first).");
  }
  console.log(bad ? `\n${bad} required check(s) failed.` : "\nAll required checks passed.");
  return bad ? 1 : 0;
}

async function init(p: Parsed): Promise<number> {
  const target = path.resolve(p.positional[1] ?? ".");
  const { initProject } = await import("@botss/server");
  const r = await initProject(target);
  console.log(`${r.alreadyInitialized ? "Botss project already initialized" : "Initialized Botss project"}: ${r.root}`);
  for (const c of r.created) console.log(`  + ${c}`);
  console.log(`  integration worktree: ${r.integration}`);
  const checks = await doctorChecks();
  const missing = checks.filter((c) => !c.ok && !c.optional);
  if (missing.length) {
    console.log("\nMissing prerequisites:");
    for (const c of missing) console.log(`  - ${c.name}: ${c.fix}`);
  }
  console.log(`\nNext: botss up   (then open the printed link and describe your idea)`);
  const info = readServerInfo();
  if (info) {
    try {
      await request({ url: info.url, token: info.token, project: null, agent: false }, "POST", "/api/projects", { root: r.root });
      console.log("The running Botss server picked up this project.");
    } catch {
      /* server not running */
    }
  }
  return 0;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {
    /* print only */
  }
}

async function alive(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function up(p: Parsed): Promise<number> {
  const root = findProjectRoot();
  const existing = readServerInfo();
  if (existing && (await alive(existing.url))) {
    if (root) await request({ url: existing.url, token: existing.token, project: null, agent: false }, "POST", "/api/projects", { root }).catch(() => {});
    const link = `${existing.url}/?token=${existing.token}${root ? `#/p/${await projectIdFor(root)}` : ""}`;
    console.log(`Botss is already running: ${link}`);
    if (!p.flags["no-open"]) openBrowser(link);
    return 0;
  }
  const { BotssServer } = await import("@botss/server");
  const want = Number(flag(p, "port") ?? process.env.BOTSS_PORT ?? 4800);
  const server = new BotssServer({ port: want, openRegistered: true });
  try {
    await server.start();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") throw new CliError(`port ${want} is in use. Try \`botss up --port ${want + 1}\`.`, 2);
    throw e;
  }
  let projectHash = "";
  if (root) {
    const proj = await server.openProject(root);
    projectHash = `#/p/${proj.id}`;
  }
  const link = `${server.url}/?token=${server.tokens.master}${projectHash}`;
  console.log(`\nBotss is running on 127.0.0.1 only.\n\n  Dashboard: ${link}\n\nKeep this terminal open. Ctrl+C stops Botss and every agent.\n`);
  if (!p.flags["no-open"]) openBrowser(link);
  const shutdown = async () => {
    console.log("\nStopping Botss (agents are stopped too)...");
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => {});
  return 0;
}

async function status(p: Parsed): Promise<number> {
  const conn = await connect({ needProject: true });
  const proj = await request(conn, "GET", `/api/projects/${conn.project}`);
  const agents = (await request(conn, "GET", `/api/projects/${conn.project}/agents`)) as any[];
  if (p.flags.json) {
    console.log(JSON.stringify({ project: proj, agents }, null, 2));
    return 0;
  }
  console.log(`${proj.name}  phase: ${proj.phase}${proj.state.paused ? `  [PAUSED: ${proj.state.pauseReason ?? ""}]` : ""}`);
  console.log(`tasks: ${Object.entries(proj.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet"}`);
  console.log(`quota: ${proj.quota.usedToday.toLocaleString()} tokens today${proj.quota.allowance ? ` of ${proj.quota.allowance.toLocaleString()} allowed` : ""}${proj.quota.ok ? "" : ` — ${proj.quota.reason}`}`);
  console.log(`open questions for you: ${proj.openQuestions}`);
  const active = agents.filter((a) => a.active);
  console.log(`agents working: ${active.length}`);
  for (const a of active) console.log(`  ${a.id.padEnd(14)} ${String(a.current_task ?? "").padEnd(8)} ${a.last_action ?? ""}`);
  return 0;
}

async function control(action: string): Promise<number> {
  const conn = await connect({ needProject: true });
  const r = await request(conn, "POST", `/api/projects/${conn.project}/control/${action}`, {});
  if (action === "kill") console.log(`Kill switch: stopped ${r.killed} agent run(s). Scheduling is paused; \`botss resume\` continues.`);
  else console.log(action === "pause" ? "Paused: no new agent runs will start." : "Resumed.");
  return 0;
}

async function logs(p: Parsed): Promise<number> {
  const who = p.positional[1];
  if (!who) throw new CliError("usage: botss logs <agent|task> [-f]", 2);
  const conn = await connect({ needProject: true });
  const isTask = /^[A-Z]+-?\d+|^REL-/.test(who);
  let after = 0;
  const print = async () => {
    const q = isTask ? `task=${encodeURIComponent(who)}` : "";
    const evs = (await request(conn, "GET", `/api/projects/${conn.project}/events?limit=2000&after=${after}&${q}`)) as any[];
    for (const e of evs) {
      after = Math.max(after, e.id);
      if (!isTask && e.actor !== who) continue;
      console.log(`${e.ts.slice(11, 19)} ${String(e.actor ?? "").padEnd(12)} ${e.summary}`);
    }
  };
  await print();
  if (p.flags.f || p.flags.follow) {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      await print();
    }
  }
  return 0;
}

export async function run(group: string, p: Parsed): Promise<number> {
  switch (group) {
    case "init":
      return init(p);
    case "doctor":
      return doctor(p);
    case "up":
      return up(p);
    case "status":
      return status(p);
    case "pause":
      return control("pause");
    case "resume":
      return control("resume");
    case "stop":
      return control("kill");
    case "logs":
      return logs(p);
    default:
      throw new CliError(`unknown command "${group}". Run \`botss help\`.`, 2);
  }
}

