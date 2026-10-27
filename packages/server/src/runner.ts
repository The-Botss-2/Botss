import { parseStreamLine, type StreamEvent } from "@botss/core";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { NODE_FLAGS } from "./paths.ts";

// Agent runner. The `AgentRunner` interface keeps the orchestrator independent of the agent CLI; the only
// implementation today drives the official `claude` CLI in print mode (see docs/claude-code-integration.md).

export interface RunSpec {
  runId: string;
  cwd: string;
  env: Record<string, string>;
  sessionId: string;
  resume: boolean;
  prompt: string;
  systemFile: string;
  settingsFile: string;
  streamFile: string;
  maxTurns: number;
  model?: string;
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  timeoutMs: number;
}

export interface RunExit {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  killed: boolean;
  stderr: string;
}

export interface RunHandlers {
  onEvent(ev: StreamEvent): void;
  onExit(exit: RunExit): void;
}

export interface AgentRunner {
  start(spec: RunSpec, handlers: RunHandlers): { pid: number | undefined };
  kill(runId: string): Promise<void>;
  killAll(): Promise<void>;
  active(): string[];
}

export function claudeArgs(spec: RunSpec): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (spec.resume) args.push("--resume", spec.sessionId);
  else args.push("--session-id", spec.sessionId);
  args.push("--append-system-prompt-file", spec.systemFile);
  args.push("--settings", spec.settingsFile);
  args.push("--permission-mode", spec.permissionMode);
  // Anything that would need an interactive approval is denied instead of hanging the headless run.
  args.push("--permission-prompts", "none");
  if (spec.allowedTools.length) args.push("--allowedTools", spec.allowedTools.join(","));
  if (spec.disallowedTools.length) args.push("--disallowedTools", spec.disallowedTools.join(","));
  args.push("--max-turns", String(spec.maxTurns));
  if (spec.model) args.push("--model", spec.model);
  return args;
}

/** Resolve BOTSS_CLAUDE_BIN (default `claude`) to something spawnable on this OS. */
export function resolveBin(bin: string): { file: string; prefix: string[]; viaCmd: boolean } {
  if (/\.(m?js|ts)$/.test(bin)) return { file: process.execPath, prefix: [...NODE_FLAGS, bin], viaCmd: false };
  if (process.platform !== "win32") return { file: bin, prefix: [], viaCmd: false };
  let found = bin;
  if (!path.extname(bin) || !fs.existsSync(bin)) {
    const exts = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase());
    const dirs = path.isAbsolute(bin) ? [path.dirname(bin)] : (process.env.PATH ?? "").split(path.delimiter);
    const name = path.isAbsolute(bin) ? path.basename(bin) : bin;
    outer: for (const d of dirs) {
      for (const e of path.extname(name) ? [""] : exts) {
        const f = path.join(d, name + e);
        if (fs.existsSync(f)) {
          found = f;
          break outer;
        }
      }
    }
  }
  return { file: found, prefix: [], viaCmd: /\.(cmd|bat)$/i.test(found) };
}

function winQuote(a: string): string {
  if (a && !/[\s"^&|<>()%!]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Kill a process and its descendants. Resolves when the kill command finished (immediately on POSIX). */
export function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    // taskkill walks the tree from the parent, so it must run before the parent is gone. Async, so several
    // agents are killed in parallel.
    return new Promise((resolve) => {
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("exit", () => resolve());
      k.on("error", () => resolve());
    });
  }
  try {
    // Agents are started detached, so the process group holds the whole tree.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return Promise.resolve();
}

export class ClaudeRunner implements AgentRunner {
  private procs = new Map<string, { child: ChildProcess; killed: boolean; done: Promise<void> }>();

  private readonly bin: string;
  constructor(bin = process.env.BOTSS_CLAUDE_BIN ?? "claude") {
    this.bin = bin;
  }

  start(spec: RunSpec, handlers: RunHandlers): { pid: number | undefined } {
    const { file, prefix, viaCmd } = resolveBin(this.bin);
    const args = [...prefix, ...claudeArgs(spec)];
    fs.mkdirSync(path.dirname(spec.streamFile), { recursive: true });
    const out = fs.createWriteStream(spec.streamFile, { flags: "a" });
    const child = viaCmd
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[winQuote(file), ...args.map(winQuote)].join(" ")}"`], {
          cwd: spec.cwd,
          env: spec.env,
          windowsVerbatimArguments: true,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(file, args, { cwd: spec.cwd, env: spec.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    // The prompt goes over stdin: no argument-length or quoting limits.
    child.stdin?.on("error", () => {});
    child.stdin?.end(spec.prompt);

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    const entry = { child, killed: false, done: Promise.resolve() };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void killTree(child.pid);
    }, spec.timeoutMs);

    const rl = readline.createInterface({ input: child.stdout! });
    let rlClosed = false;
    rl.on("close", () => {
      rlClosed = true;
    });
    rl.on("line", (line) => {
      out.write(`${line}\n`);
      for (const ev of parseStreamLine(line)) {
        try {
          handlers.onEvent(ev);
        } catch (e) {
          console.error("[botss] stream handler error", e);
        }
      }
    });
    entry.done = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (code: number | null, signal: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.procs.delete(spec.runId);
        const close = () => {
          out.end();
          handlers.onExit({ code, signal, timedOut, killed: entry.killed, stderr });
          resolve();
        };
        // Let readline drain buffered lines before reporting the exit.
        let reported = false;
        const report = () => {
          if (reported) return;
          reported = true;
          close();
        };
        if (rlClosed) report();
        else {
          rl.once("close", report);
          setTimeout(() => {
            rl.close();
            report();
          }, 500);
        }
      };
      // "close" fires after stdio ends, so every stream line has been read by then.
      child.on("close", (code, signal) => finish(code, signal));
      child.on("error", (err) => {
        stderr += `\n${err.message}`;
        finish(127, null);
      });
    });
    this.procs.set(spec.runId, entry);
    return { pid: child.pid };
  }

  async kill(runId: string): Promise<void> {
    const p = this.procs.get(runId);
    if (!p) return;
    p.killed = true;
    if (p.child.pid) await killTree(p.child.pid);
    await Promise.race([p.done, new Promise((r) => setTimeout(r, 1500))]);
  }

  async killAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.kill(id)));
  }

  active(): string[] {
    return [...this.procs.keys()];
  }
}
