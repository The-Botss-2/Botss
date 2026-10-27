import { emptyUsage, type UsageTotals } from "./types.ts";

// Turns `claude -p --output-format stream-json --verbose` lines into compact feed events.
// See docs/claude-code-integration.md for the event shapes this relies on.

export type StreamEvent =
  | { kind: "init"; sessionId: string; model?: string; tools?: string[] }
  | { kind: "tool"; tool: string; summary: string; file?: string; toolUseId?: string }
  | { kind: "text"; text: string }
  | { kind: "tool_error"; toolUseId?: string; text: string }
  | { kind: "retry"; error: string; attempt?: number; delayMs?: number }
  | { kind: "rate_limit"; status: string; resetsAt?: number }
  | {
      kind: "result";
      subtype: string;
      isError: boolean;
      turns: number;
      costUsd: number;
      usage: UsageTotals;
      sessionId?: string;
      text: string;
      usageLimit?: { resetsAt?: number };
    };

function short(s: string, n = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function summarizeTool(name: string, input: Record<string, unknown>): { summary: string; file?: string } {
  const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  switch (name) {
    case "Edit":
    case "MultiEdit":
      return { summary: `Editing \`${file}\``, file };
    case "Write":
      return { summary: `Writing \`${file}\``, file };
    case "Read":
      return { summary: `Reading \`${file}\``, file };
    case "NotebookEdit":
      return { summary: `Editing notebook \`${file}\``, file };
    case "Bash":
      return { summary: `Running \`${short(String(input.command ?? ""), 100)}\`` };
    case "Grep":
      return { summary: `Searching for \`${short(String(input.pattern ?? ""), 60)}\`` };
    case "Glob":
      return { summary: `Finding files \`${short(String(input.pattern ?? ""), 60)}\`` };
    case "TodoWrite":
      return { summary: "Updating its todo list" };
    default:
      return { summary: `Using ${name}` };
  }
}

function toUsage(u: unknown): UsageTotals {
  const x = (u ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof x[k] === "number" ? (x[k] as number) : 0);
  return {
    input_tokens: n("input_tokens"),
    output_tokens: n("output_tokens"),
    cache_creation_input_tokens: n("cache_creation_input_tokens"),
    cache_read_input_tokens: n("cache_read_input_tokens"),
  };
}

const LIMIT_RE = /(usage limit|session limit|weekly limit|hit your (session |weekly )?limit|rate[_ -]?limit|Claude AI usage limit reached)/i;

/** Best effort: find a reset time in an error string ("…|1730000000", "resets 3:45pm", "resets at 15:00"). */
export function parseResetTime(text: string, now = new Date()): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(text) ?? /resets?(?:At|_at)?["\s:=]+(\d{10})\b/i.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clock) {
    let h = Number(clock[1]);
    const m = Number(clock[2] ?? 0);
    const ap = clock[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return undefined;
}

export function isUsageLimitText(text: string): boolean {
  return LIMIT_RE.test(text);
}

export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const out: StreamEvent[] = [];
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") out.push({ kind: "init", sessionId: String(ev.session_id ?? ""), model: ev.model, tools: ev.tools });
      else if (ev.subtype === "api_retry")
        out.push({ kind: "retry", error: String(ev.error ?? ev.error_status ?? "retry"), attempt: ev.attempt, delayMs: ev.retry_delay_ms });
      break;
    case "rate_limit_event": {
      const info = (ev.rate_limit_info ?? ev) as Record<string, any>;
      const resets = info.resetsAt ?? info.resets_at;
      out.push({
        kind: "rate_limit",
        status: String(info.status ?? "unknown"),
        resetsAt: typeof resets === "number" ? (resets < 1e12 ? resets * 1000 : resets) : undefined,
      });
      break;
    }
    case "assistant": {
      for (const block of ev.message?.content ?? []) {
        if (block?.type === "tool_use") {
          const s = summarizeTool(String(block.name), (block.input ?? {}) as Record<string, unknown>);
          out.push({ kind: "tool", tool: String(block.name), toolUseId: block.id, ...s });
        } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 12) {
          out.push({ kind: "text", text: short(block.text, 200) });
        }
      }
      break;
    }
    case "user": {
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result" && block.is_error) {
            const text = Array.isArray(block.content)
              ? block.content.map((c: any) => c?.text ?? "").join(" ")
              : String(block.content ?? "");
            out.push({ kind: "tool_error", toolUseId: block.tool_use_id, text: short(text, 240) });
          }
        }
      }
      break;
    }
    case "result": {
      const text = String(ev.result ?? (Array.isArray(ev.errors) ? ev.errors.join("; ") : ""));
      const isError = Boolean(ev.is_error) || String(ev.subtype ?? "").startsWith("error");
      const limited = isError && isUsageLimitText(text);
      out.push({
        kind: "result",
        subtype: String(ev.subtype ?? "unknown"),
        isError,
        turns: Number(ev.num_turns ?? 0),
        costUsd: Number(ev.total_cost_usd ?? 0),
        usage: toUsage(ev.usage),
        sessionId: ev.session_id,
        text: short(text, 400),
        usageLimit: limited ? { resetsAt: parseResetTime(text) } : undefined,
      });
      break;
    }
  }
  return out;
}

export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  const r = emptyUsage();
  for (const k of Object.keys(r) as (keyof UsageTotals)[]) r[k] = a[k] + b[k];
  return r;
}
