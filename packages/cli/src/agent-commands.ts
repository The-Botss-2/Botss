import fs from "node:fs";
import path from "node:path";
import { flag, type Parsed } from "./args.ts";
import { CliError, cmd, connect } from "./client.ts";

// The agent-facing commands of skills/team-protocol/references/botss-cli.md.

function readScratch(file: string | undefined, what: string, required = true): string | null {
  if (!file) {
    if (required) throw new CliError(`${what} is required`, 2);
    return null;
  }
  const f = path.resolve(file);
  if (!fs.existsSync(f)) throw new CliError(`${what} file not found: ${file}`, 2);
  return fs.readFileSync(f, "utf8");
}

function need(v: string | undefined, usage: string): string {
  if (!v) throw new CliError(`usage: ${usage}`, 2);
  return v;
}

const STANDARD_PATHS: Record<string, string> = {
  prd: ".botss/docs/prd.md",
  architecture: ".botss/docs/architecture.md",
  codebase: ".botss/docs/codebase.md",
  design: ".botss/docs/design/DESIGN.md",
  plan: ".botss/docs/plan-summary.md",
};

function standardPath(name: string): string {
  if (STANDARD_PATHS[name]) return STANDARD_PATHS[name]!;
  if (name.includes("/")) return `.botss/docs/${name}${name.startsWith("decisions/") && !name.endsWith(".md") ? ".md" : ""}`;
  throw new CliError(`unknown document "${name}"`, 2);
}

function readPlanDir(dir: string): { file: string; source: string }[] {
  const d = path.resolve(dir);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new CliError(`not a directory: ${dir}`, 2);
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".md") && !/^readme/i.test(f))
    .sort()
    .map((f) => ({ file: path.join(dir, f).replace(/\\/g, "/"), source: fs.readFileSync(path.join(d, f), "utf8") }));
}

export const AGENT_COMMANDS = new Set(["whoami", "task", "doc", "progress", "msg", "ask", "inbox", "reply", "decision", "plan", "review", "qa", "bug"]);

export async function runAgentCommand(p: Parsed): Promise<{ text: string; data: unknown; exit: number; ok: boolean }> {
  const [group, sub, ...rest] = p.positional;
  const conn = await connect({ needProject: true });
  const task = (v: string | undefined) => v ?? process.env.BOTSS_TASK;
  switch (group) {
    case "whoami":
      return cmd(conn, "whoami", {});
    case "progress":
      return cmd(conn, "progress", { text: need([sub, ...rest].filter(Boolean).join(" "), 'botss progress "<text>"') });
    case "msg":
      return cmd(conn, "msg", { to: need(sub, 'botss msg @<role-or-agent> "<text>"'), body: need(rest.join(" "), 'botss msg @<role-or-agent> "<text>"') });
    case "ask": {
      const to = need(sub, 'botss ask @<role> "<question>"');
      const batchFile = flag(p, "batch");
      if (batchFile) {
        const text = readScratch(batchFile, "--batch")!;
        let batch: unknown;
        try {
          batch = JSON.parse(text);
        } catch (e) {
          throw new CliError(`--batch file is not valid JSON: ${(e as Error).message}`, 2);
        }
        return cmd(conn, "ask", { to, batch });
      }
      return cmd(conn, "ask", { to, body: need(rest.join(" "), 'botss ask @<role> "<question>"') });
    }
    case "inbox":
      return cmd(conn, "inbox", { all: Boolean(p.flags.all) });
    case "reply":
      return cmd(conn, "reply", { id: need(sub, 'botss reply M-0042 "<text>"'), body: need(rest.join(" "), 'botss reply M-0042 "<text>"') });
    case "decision": {
      if (sub === "list") return cmd(conn, "decision.list", {});
      if (sub === "show") return cmd(conn, "decision.show", { id: need(rest[0], "botss decision show D-007") });
      const title = need([sub, ...rest].filter(Boolean).join(" "), 'botss decision "<title>" --why "<reason>" [--affects a,b]');
      const r = await cmd(conn, "decision", {
        title,
        why: flag(p, "why") ?? "",
        affects: (flag(p, "affects") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      });
      const d = r.data as { markdown?: string; path?: string } | null;
      const wt = process.env.BOTSS_WORKTREE;
      if (d?.markdown && d.path && wt && fs.existsSync(wt)) {
        const f = path.join(wt, d.path);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, d.markdown);
        r.text += ` (written to ${d.path}; commit it with your work)`;
      }
      return r;
    }
    case "task":
      switch (sub) {
        case "show":
          return cmd(conn, "task.show", { task: need(task(rest[0]), "botss task show <id>") });
        case "list":
          return cmd(conn, "task.list", { ready: Boolean(p.flags.ready), role: flag(p, "role"), status: flag(p, "status") });
        case "start":
          return cmd(conn, "task.start", { task: need(task(rest[0]), "botss task start <id>") });
        case "block":
          return cmd(conn, "task.block", { task: need(task(rest[0]), "botss task block <id> --on <who> --reason <text>"), on: flag(p, "on"), reason: flag(p, "reason") });
        case "unblock":
          return cmd(conn, "task.unblock", { task: need(task(rest[0]), "botss task unblock <id>") });
        case "done": {
          const id = need(task(rest[0]), "botss task done <id> --status DONE --handoff .botss/handoffs/<id>.md");
          const status = need(flag(p, "status"), "botss task done <id> --status DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT --handoff <file>");
          return cmd(conn, "task.done", { task: id, status, handoff: readScratch(flag(p, "handoff"), "--handoff") });
        }
        default:
          throw new CliError("usage: botss task show|list|start|block|unblock|done ...", 2);
      }
    case "doc":
      switch (sub) {
        case "list":
          return cmd(conn, "doc.list", {});
        case "show":
          return cmd(conn, "doc.show", { name: need(rest[0], "botss doc show <name>") });
        case "submit": {
          const name = need(rest[0], "botss doc submit <name> [--file <path>]");
          const file = flag(p, "file") ?? standardPath(name);
          return cmd(conn, "doc.submit", { name, file: file.replace(/\\/g, "/"), content: readScratch(file, "--file") });
        }
        default:
          throw new CliError("usage: botss doc list|show|submit ...", 2);
      }
    case "plan": {
      const dir = rest[0] ?? ".botss/tasks/";
      const files = readPlanDir(dir);
      if (sub === "check") return cmd(conn, "plan.check", { files });
      if (sub === "submit") {
        const summaryFile = path.resolve(".botss/docs/plan-summary.md");
        const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : null;
        return cmd(conn, "plan.submit", { files, summary });
      }
      throw new CliError("usage: botss plan check|submit <dir>", 2);
    }
    case "review": {
      const id = need(task(rest[0]), `botss review ${sub ?? "<start|comment|approve|request-changes>"} <task>`);
      switch (sub) {
        case "start":
          return cmd(conn, "review.start", { task: id });
        case "comment":
          return cmd(conn, "review.comment", { task: id, file: flag(p, "file"), line: flag(p, "line"), severity: flag(p, "severity") ?? "minor", body: need(rest.slice(1).join(" "), 'botss review comment <task> --file <f> --line <n> --severity <s> "<text>"') });
        case "approve":
          return cmd(conn, "review.approve", { task: id, summary: flag(p, "summary") ?? "" });
        case "request-changes":
          return cmd(conn, "review.request-changes", { task: id, summary: flag(p, "summary") ?? "", content: readScratch(flag(p, "file"), "--file", false) });
        default:
          throw new CliError("usage: botss review start|comment|approve|request-changes <task>", 2);
      }
    }
    case "qa": {
      const id = need(task(rest[0]), `botss qa ${sub ?? "pass|fail"} <task> --report <file>`);
      const report = readScratch(flag(p, "report"), "--report")!;
      if (sub === "pass") return cmd(conn, "qa.pass", { task: id, report });
      if (sub === "fail") return cmd(conn, "qa.fail", { task: id, report });
      throw new CliError("usage: botss qa pass|fail <task> --report <file>", 2);
    }
    case "bug": {
      if (sub !== "create") throw new CliError("usage: botss bug create --task <id> --severity <s> --title <t> [--file <f>]", 2);
      return cmd(conn, "bug.create", {
        task: need(flag(p, "task") ?? process.env.BOTSS_TASK, "botss bug create --task <id> ..."),
        severity: need(flag(p, "severity"), "--severity blocker|major|minor|trivial"),
        title: need(flag(p, "title"), "--title <text>"),
        content: readScratch(flag(p, "file"), "--file", false) ?? "",
      });
    }
    default:
      throw new CliError(`unknown command ${group}`, 2);
  }
}
