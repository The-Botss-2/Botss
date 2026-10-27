#!/usr/bin/env node
import { parseArgs } from "./args.ts";
import { AGENT_COMMANDS, runAgentCommand } from "./agent-commands.ts";
import { CliError } from "./client.ts";

const HELP = `botss — your local AI software team (runs on your own Claude Code)

Owner commands:
  botss init [path]          make a folder a Botss project (git, .botss/, skills, integration branch)
  botss doctor [--login]     check prerequisites (node, pnpm, git, docker, uv, claude)
  botss up [--port N] [--no-open]   start the local server + dashboard (127.0.0.1 only)
  botss status               phase, tasks, agents, quota for the current project
  botss pause | resume       stop/start scheduling new agent runs
  botss stop                 kill switch: stop every agent process now
  botss logs <agent|task> [-f]   recent events for an agent (backend-1) or task (T012)

Agent commands (used by agents inside runs; see .botss/skills/team-protocol/references/botss-cli.md):
  whoami, task show|list|start|block|unblock|done, progress, msg, ask, inbox, reply,
  decision, doc list|show|submit, plan check|submit, review ..., qa pass|fail, bug create

Add --json for machine-readable output.
Exit codes: 0 ok, 1 refused, 2 invalid arguments, 3 not allowed, 4 server unreachable.`;

async function main(argv: string[]): Promise<number> {
  const p = parseArgs(argv);
  const group = p.positional[0];
  const json = Boolean(p.flags.json);
  if (!group || group === "help" || p.flags.help) {
    console.log(HELP);
    return 0;
  }
  if (group === "hook") {
    const { preToolUseHook } = await import("./hook.ts");
    if (p.positional[1] === "pre-tool-use") return preToolUseHook();
    throw new CliError("usage: botss hook pre-tool-use", 2);
  }
  if (AGENT_COMMANDS.has(group)) {
    const r = await runAgentCommand(p);
    if (json) console.log(JSON.stringify({ ok: r.ok, text: r.text, data: r.data }, null, 2));
    else if (r.exit) console.error(r.text);
    else console.log(r.text);
    return r.exit ?? 0;
  }
  const human = await import("./human.ts");
  return human.run(group, p);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    if (e instanceof CliError) {
      if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: false, error: e.message, exit: e.exit }));
      else console.error(`botss: ${e.message}`);
      process.exitCode = e.exit;
    } else {
      console.error(`botss: ${(e as Error)?.stack ?? e}`);
      process.exitCode = 1;
    }
  },
);
