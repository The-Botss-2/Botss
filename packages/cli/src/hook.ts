import { guardDecision, type GuardContext } from "@botss/core/guard";
import fs from "node:fs";
import path from "node:path";

// `botss hook pre-tool-use`: the PreToolUse guard. Claude Code pipes the hook JSON on stdin; exit 2 blocks the
// tool call and stderr becomes the reason the agent sees. Must stay fast: no server round trip on the allow path.

function realpathDeep(p: string): string {
  let probe = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) {
    tail.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  try {
    return path.join(fs.realpathSync(probe), ...tail);
  } catch {
    return path.resolve(p);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function preToolUseHook(): Promise<number> {
  const guardFile = process.env.BOTSS_GUARD_FILE;
  const raw = await readStdin();
  if (!guardFile) return 0; // Not a Botss agent run.
  let ctx: GuardContext & { projectId?: string };
  try {
    ctx = JSON.parse(fs.readFileSync(guardFile, "utf8"));
  } catch {
    process.stderr.write("Botss guard: run context missing; refusing tool call.\n");
    return 2;
  }
  let input: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write("Botss guard: could not parse hook input.\n");
    return 2;
  }
  const decision = guardDecision(
    { tool_name: String(input.tool_name ?? ""), tool_input: input.tool_input ?? {}, cwd: input.cwd },
    { ...ctx, realpath: realpathDeep },
  );
  if (decision.allow) return 0;
  process.stderr.write(`${decision.reason}\n`);
  // Best effort: put the block on the live feed.
  const url = process.env.BOTSS_SERVER_URL;
  const token = process.env.BOTSS_TOKEN;
  if (url && token && ctx.projectId) {
    const target = String(input.tool_input?.file_path ?? input.tool_input?.command ?? "").slice(0, 300);
    try {
      await fetch(`${url}/api/projects/${ctx.projectId}/guard-block`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: input.tool_name, reason: decision.reason, target }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      /* the block itself is what matters */
    }
  }
  return 2;
}
