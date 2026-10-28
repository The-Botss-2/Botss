import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
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

/** Run a tool by name. On Windows npm tools are .cmd shims, so go through the shell with one command string
 * (the args here are fixed words, no user input). */
function runTool(cmd: string, args: string[], opts: { input?: string; timeout: number }) {
  const o = { encoding: "utf8" as const, timeout: opts.timeout, windowsHide: true, input: opts.input };
  return process.platform === "win32" ? spawnSync([cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), { ...o, shell: true }) : spawnSync(cmd, args, o);
}

function probe(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = runTool(cmd, args, { timeout: 20_000 });
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
      const r = runTool(process.env.BOTSS_CLAUDE_BIN ?? "claude", ["-p", "--max-turns", "1", "--output-format", "json"], { input: "Reply with the single word: ok", timeout: 120_000 });
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
  if (r.integration !== r.root) console.log(`  integration worktree: ${r.integration}`);
  if (r.existing) console.log("  existing code found: the tech lead will survey it first, and the team changes only what you ask.");
  for (const w of r.warnings) console.log(`  ! ${w}`);
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
  // rundll32 avoids cmd.exe, which would mangle %XX escapes and & in the URL.
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
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

/**
 * After an update the server that is already running still has the old code. Restart it when no agent is working;
 * otherwise say so. Returns true when the running server can be used as is.
 */
async function restartIfOutdated(info: { url: string; token: string }): Promise<boolean> {
  const { buildId } = await import("@botss/server");
  let build: string | undefined;
  try {
    build = ((await (await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(1500) })).json()) as { build?: string }).build;
  } catch {
    return true;
  }
  if (build === buildId()) return true;
  console.log("Botss was updated, but the server that is running still has the old code. Restarting it...");
  const res = await fetch(`${info.url}/api/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ifIdle: true }),
  }).catch(() => null);
  if (!res || !res.ok) {
    const why = res?.status === 409 ? "agents are working right now" : "it is too old to restart itself";
    throw new CliError(
      `The running Botss server is out of date and could not be restarted (${why}). Stop it with Ctrl+C in the terminal where you ran \`botss up\` (or \`botss stop\` first if agents are working), then run \`botss up\` again.`,
      1,
    );
  }
  for (let i = 0; i < 50 && (await alive(info.url)); i++) await new Promise((r) => setTimeout(r, 200));
  return false;
}

/** Dashboard route for the folder `botss up` runs in: the project itself, or the folder picker opened there. */
async function routeFor(dir: string, root: string | null): Promise<string> {
  return root ? `#/p/${await projectIdFor(root)}` : `#/open?path=${encodeURIComponent(dir)}`;
}

async function up(p: Parsed): Promise<number> {
  const cwd = path.resolve(p.positional[1] ?? ".");
  const root = findProjectRoot(cwd);
  let existing = readServerInfo();
  if (existing && (await alive(existing.url)) && !(await restartIfOutdated(existing))) existing = null;
  if (existing && (await alive(existing.url))) {
    const conn = { url: existing.url, token: existing.token, project: null, agent: false };
    if (root) await request(conn, "POST", "/api/projects", { root }).catch(() => {});
    await request(conn, "POST", "/api/launch", { dir: root ?? cwd }).catch(() => {});
    const link = `${existing.url}/?token=${existing.token}${await routeFor(cwd, root)}`;
    console.log(`Botss is already running. ${root ? `Opening ${root}` : `Choose where to put your project (starting at ${cwd})`}:\n\n  ${link}\n`);
    if (!p.flags["no-open"]) openBrowser(link);
    return 0;
  }
  const { BotssServer } = await import("@botss/server");
  const want = Number(flag(p, "port") ?? process.env.BOTSS_PORT ?? 4800);
  const server = new BotssServer({ port: want, openRegistered: true, launchDir: root ?? cwd });
  server.onShutdown = () => {
    console.log("\nBotss was restarted by a newer `botss up` in another terminal. This one is done.");
    process.exit(0);
  };
  try {
    await server.start();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") throw new CliError(`port ${want} is in use. Try \`botss up --port ${want + 1}\`.`, 2);
    throw e;
  }
  if (root) await server.openProject(root);
  const link = `${server.url}/?token=${server.tokens.master}${await routeFor(cwd, root)}`;
  const what = root ? `Project: ${root}` : `This folder is not a Botss project yet; the dashboard lets you pick or create one (starting at ${cwd}).`;
  console.log(`\nBotss is running on 127.0.0.1 only.\n\n  Dashboard: ${link}\n  ${what}\n\nKeep this terminal open. Ctrl+C stops Botss and every agent.\n`);
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

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "botss.js");

function onPath(dir: string): boolean {
  const norm = (d: string) => path.resolve(d).toLowerCase().replace(/[\\/]+$/, "");
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).some((d) => norm(d) === norm(dir));
}

/** Install a `botss` command usable from any folder: a small launcher that runs this checkout's CLI. */
async function setup(p: Parsed): Promise<number> {
  const node = process.execPath;
  const remove = Boolean(p.flags.uninstall);
  if (process.platform === "win32") {
    const dir = path.join(os.homedir(), ".botss", "bin");
    const cmdFile = path.join(dir, "botss.cmd");
    const shFile = path.join(dir, "botss");
    if (remove) {
      fs.rmSync(cmdFile, { force: true });
      fs.rmSync(shFile, { force: true });
      console.log(`Removed ${cmdFile}. (${dir} stays on your PATH; remove it in System Settings if you like.)`);
      return 0;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cmdFile, `@echo off\r\n"${node}" "${LAUNCHER}" %*\r\n`);
    // Git Bash (which Claude Code uses on Windows) runs extensionless scripts.
    fs.writeFileSync(shFile, `#!/bin/sh\nexec "${node.replace(/\\/g, "/")}" "${LAUNCHER.replace(/\\/g, "/")}" "$@"\n`);
    // Add the folder to the *user* PATH (no admin rights, no truncation like setx).
    const ps = (script: string) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
    const cur = ps("[Environment]::GetEnvironmentVariable('Path','User')").stdout.trim();
    const parts = cur.split(";").filter(Boolean);
    if (!parts.some((x) => path.resolve(x).toLowerCase() === dir.toLowerCase())) {
      const next = [...parts, dir].join(";").replace(/'/g, "''");
      const r = ps(`[Environment]::SetEnvironmentVariable('Path','${next}','User')`);
      if (r.status !== 0) {
        console.log(`Installed ${cmdFile}, but could not update PATH automatically. Add this folder to your user PATH:\n  ${dir}`);
        return 1;
      }
      console.log(`Added ${dir} to your user PATH.`);
    }
    console.log(`Installed the botss command (${cmdFile}).\n\nOpen a NEW terminal, then from any folder:\n  botss init      make this folder a Botss project\n  botss up        start Botss and open the dashboard here`);
    return 0;
  }
  const dir = path.join(os.homedir(), ".local", "bin");
  const file = path.join(dir, "botss");
  if (remove) {
    fs.rmSync(file, { force: true });
    console.log(`Removed ${file}.`);
    return 0;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nexec "${node}" "${LAUNCHER}" "$@"\n`, { mode: 0o755 });
  console.log(`Installed the botss command (${file}).`);
  if (!onPath(dir)) {
    const shell = path.basename(process.env.SHELL ?? "bash");
    console.log(`\n${dir} is not on your PATH yet. Add this line to ~/.${shell === "zsh" ? "zshrc" : "bashrc"} and open a new terminal:\n  export PATH="$HOME/.local/bin:$PATH"`);
  }
  console.log(`\nFrom any folder:\n  botss init      make this folder a Botss project\n  botss up        start Botss and open the dashboard here`);
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
    case "setup":
      return setup(p);
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

