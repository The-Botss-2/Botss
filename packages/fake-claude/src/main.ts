#!/usr/bin/env node
// fake-claude: a test double for the `claude` CLI. Accepts the flags Botss passes, prints stream-json like
// `claude -p --output-format stream-json --verbose`, runs PreToolUse hooks from --settings exactly like
// Claude Code does (stdin JSON, exit 2 blocks), and acts out a scenario file (BOTSS_FAKE_SCENARIO).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../cli/src/main.ts");

type Step =
  | { write: string; content: string }
  | { append: string; content: string }
  | { bash: string; allowFail?: boolean }
  | { botss: string[]; allowFail?: boolean }
  | { text: string }
  | { sleep: number }
  | { hang: true }
  | { usageLimit: { inSeconds?: number } }
  | { exit: number }
  | { expectPrompt: string }
  | { rateLimit: { status: string; inSeconds?: number } };

interface Script {
  steps: Step[];
  exitCode?: number;
  resultText?: string;
}

type ScenarioValue = Script | Script[];

function parseFlags(argv: string[]) {
  const f: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) continue;
    const k = a.replace(/^--?/, "");
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      f[k] = next;
      i++;
    } else f[k] = true;
  }
  return f;
}

function findShell(): string {
  if (process.env.BOTSS_SHELL) return process.env.BOTSS_SHELL;
  if (process.platform === "win32") {
    for (const c of ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"]) if (fs.existsSync(c)) return c;
    return "bash.exe";
  }
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function expand(s: string, ctx: Record<string, string>): string {
  return s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, k: string) => ctx[k] ?? process.env[k] ?? "");
}

function nextIndex(stateDir: string | undefined, key: string): number {
  if (!stateDir) return 0;
  fs.mkdirSync(stateDir, { recursive: true });
  const f = path.join(stateDir, `count-${key.replace(/[^A-Za-z0-9_.-]/g, "_")}`);
  const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;
  fs.writeFileSync(f, String(n + 1));
  return n;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  if (flags.version || flags.v) {
    console.log("2.1.999 (Claude Code fake)");
    return 0;
  }
  if (!flags.p && !flags.print) {
    console.error("fake-claude only supports -p");
    return 1;
  }
  const prompt = await readStdin();
  const resume = typeof flags.resume === "string" ? flags.resume : null;
  const sessionId = resume ?? (typeof flags["session-id"] === "string" ? flags["session-id"] : crypto.randomUUID());
  const role = process.env.BOTSS_ROLE ?? "";
  const task = process.env.BOTSS_TASK ?? "";
  const mode = process.env.BOTSS_MODE ?? "";
  const stateDir = process.env.BOTSS_FAKE_STATE;
  const cwd = process.cwd();

  if (stateDir) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, "invocations.jsonl"),
      `${JSON.stringify({ role, task, mode, resume, sessionId, argv, prompt: prompt.slice(0, 4000), cwd, pid: process.pid, at: Date.now() })}\n`,
    );
  }
  for (const req of ["output-format", "append-system-prompt-file", "settings", "permission-mode", "max-turns"]) {
    if (!flags[req]) {
      console.error(`fake-claude: missing --${req}`);
      return 2;
    }
  }
  const systemFile = String(flags["append-system-prompt-file"]);
  if (!fs.existsSync(systemFile)) {
    console.error(`Error: Append system prompt file not found: ${systemFile}`);
    return 1;
  }

  const scenarioFile = process.env.BOTSS_FAKE_SCENARIO;
  const scenario: Record<string, ScenarioValue> = scenarioFile ? JSON.parse(fs.readFileSync(scenarioFile, "utf8")) : {};
  const keys: string[] = [];
  const base = [task && `task:${task}:${mode}`, task && `task:${task}:${role}`, task && `task:${task}`, `${role}:${mode}`, role, "default"].filter(Boolean) as string[];
  if (resume) keys.push(...base.map((k) => `${k}:resume`));
  keys.push(...base);
  const key = keys.find((k) => scenario[k] !== undefined);
  let script: Script = { steps: [{ text: "Nothing to do in this scenario." }] };
  if (key) {
    const v = scenario[key]!;
    if (Array.isArray(v)) {
      const i = nextIndex(stateDir, key);
      script = v[Math.min(i, v.length - 1)]!;
    } else script = v;
  }

  const ctx: Record<string, string> = { ...(process.env as Record<string, string>), ASK_ID: /M-\d{4}/.exec(prompt)?.[0] ?? "", SESSION_ID: sessionId, MERGE_BRANCH: /Branch to merge: `([^`]+)`/.exec(prompt)?.[1] ?? "" };
  out({ type: "system", subtype: "init", session_id: sessionId, cwd, model: String(flags.model ?? "claude-fake"), tools: ["Bash", "Edit", "Write", "Read"], permissionMode: flags["permission-mode"] });

  const settings = JSON.parse(fs.readFileSync(String(flags.settings), "utf8")) as { hooks?: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
  const preHooks = settings.hooks?.PreToolUse ?? [];
  const runHooks = (toolName: string, toolInput: Record<string, unknown>, id: string): string | null => {
    for (const h of preHooks) {
      if (h.matcher && !new RegExp(`^(${h.matcher})$`).test(toolName)) continue;
      for (const c of h.hooks) {
        // Claude Code runs command hooks through bash (Git Bash on Windows).
        const r = spawnSync(findShell(), ["-c", c.command], {
          input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, tool_use_id: id, permission_mode: flags["permission-mode"] }),
          encoding: "utf8",
          env: process.env,
          windowsHide: true,
        });
        if (r.status === 2) return (r.stderr || "blocked by hook").trim();
      }
    }
    return null;
  };

  let turns = 0;
  const tool = (name: string, input: Record<string, unknown>, act: () => { ok: boolean; output: string }) => {
    turns++;
    const id = `toolu_${crypto.randomBytes(6).toString("hex")}`;
    out({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    const blocked = runHooks(name, input, id);
    if (blocked) {
      out({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: blocked }] } });
      return { ok: false, output: blocked };
    }
    const r = act();
    out({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: !r.ok, content: r.output.slice(0, 4000) }] } });
    return r;
  };
  const finish = (isError: boolean, text: string, code: number, subtype = isError ? "error_during_execution" : "success") => {
    out({
      type: "result",
      subtype,
      is_error: isError,
      num_turns: Math.max(1, turns),
      duration_ms: 10,
      total_cost_usd: 0.01 * Math.max(1, turns),
      usage: { input_tokens: 1000 * Math.max(1, turns), output_tokens: 200 * Math.max(1, turns), cache_creation_input_tokens: 100, cache_read_input_tokens: 5000 },
      session_id: sessionId,
      ...(isError ? { errors: [text], result: text } : { result: text }),
    });
    return code;
  };

  for (const s of script.steps) {
    if ("expectPrompt" in s) {
      if (!prompt.includes(expand(s.expectPrompt, ctx))) return finish(true, `fake-claude: prompt did not contain "${s.expectPrompt}"`, 3);
    } else if ("text" in s) {
      turns++;
      out({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "text", text: expand(s.text, ctx) }] } });
    } else if ("write" in s || "append" in s) {
      const rel = expand("write" in s ? s.write : s.append, ctx);
      const content = expand(s.content, ctx);
      const full = path.resolve(cwd, rel);
      tool("write" in s ? "Write" : "Edit", { file_path: full, content }, () => {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if ("write" in s) fs.writeFileSync(full, content);
        else fs.appendFileSync(full, content);
        return { ok: true, output: `wrote ${rel}` };
      });
    } else if ("bash" in s || "botss" in s) {
      const command = "bash" in s ? expand(s.bash, ctx) : `botss ${s.botss.map((a) => expand(a, ctx)).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
      const r = tool("Bash", { command }, () => {
        const res =
          "bash" in s
            ? spawnSync(findShell(), ["-c", command], { cwd, env: process.env, encoding: "utf8", windowsHide: true })
            : spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...s.botss.map((a) => expand(a, ctx))], { cwd, env: process.env, encoding: "utf8", windowsHide: true });
        return { ok: res.status === 0, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
      });
      if (!r.ok && !s.allowFail && !/Botss guard/.test(r.output)) {
        process.stderr.write(`fake-claude step failed: ${command}\n${r.output}\n`);
      }
    } else if ("sleep" in s) {
      await new Promise((res) => setTimeout(res, s.sleep));
    } else if ("hang" in s) {
      // A pending promise alone does not keep Node alive; a timer does.
      await new Promise(() => setInterval(() => {}, 60_000));
    } else if ("rateLimit" in s) {
      out({ type: "rate_limit_event", rate_limit_info: { status: s.rateLimit.status, resetsAt: Math.floor(Date.now() / 1000) + (s.rateLimit.inSeconds ?? 60) } });
    } else if ("usageLimit" in s) {
      const resets = Math.floor(Date.now() / 1000) + (s.usageLimit.inSeconds ?? 3600);
      return finish(true, `Claude AI usage limit reached|${resets}`, 1);
    } else if ("exit" in s) {
      return finish(true, `fake-claude exiting with ${s.exit}`, s.exit);
    }
  }
  const code = script.exitCode ?? 0;
  return finish(code !== 0, script.resultText ?? "Done.", code);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e);
    process.exitCode = 1;
  },
);
