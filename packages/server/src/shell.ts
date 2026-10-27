import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";

// Verify and check commands are POSIX shell (`cd backend && X=1 uv run pytest`). Run them with bash
// (Git Bash on Windows), falling back to sh.

let cachedShell: string | null = null;

export function findShell(): string {
  if (process.env.BOTSS_SHELL) return process.env.BOTSS_SHELL;
  if (cachedShell) return cachedShell;
  const candidates =
    process.platform === "win32"
      ? ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe", "bash.exe"]
      : ["/bin/bash", "/usr/bin/bash", "/bin/sh"];
  cachedShell = candidates.find((c) => !path.isAbsolute(c) || fs.existsSync(c)) ?? "sh";
  return cachedShell;
}

export interface ShellResult {
  code: number;
  output: string;
  timedOut: boolean;
}

export async function runShell(command: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<ShellResult> {
  const r = await execa(findShell(), ["-c", command], {
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: true,
    reject: false,
    all: true,
    timeout: opts.timeoutMs,
    stripFinalNewline: true,
  });
  const output = String(r.all ?? "");
  return {
    code: r.timedOut ? 124 : (r.exitCode ?? 1),
    output: output.length > 20_000 ? `…(truncated)\n${output.slice(-20_000)}` : output,
    timedOut: Boolean(r.timedOut),
  };
}
