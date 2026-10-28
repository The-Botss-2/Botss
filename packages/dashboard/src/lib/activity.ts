import type { BotssEvent, Run, Task } from "./types";

// Turns a run's raw events into what a non-engineer wants to see: what the agent is doing now, its plan,
// which files it touched, and a few human-readable moments.

export type Activity =
  | "reading"
  | "searching"
  | "writing"
  | "testing"
  | "checking"
  | "installing"
  | "running"
  | "talking"
  | "planning"
  | "reviewing"
  | "handing_off";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  activeForm?: string;
}

export interface Moment {
  id: number;
  ts: string;
  text: string;
  tone: "neutral" | "ok" | "bad" | "talk";
}

export interface Insight {
  label: string | null;
  activity: Activity | null;
  todos: Todo[] | null;
  files: { path: string; wrote: boolean }[];
  moments: Moment[];
  lastTs: string | null;
}

export function parseTodos(v: unknown): Todo[] | null {
  let arr: unknown = v;
  if (typeof v === "string") {
    try {
      arr = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  const out = arr
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
    .map((t) => ({
      content: String(t.content ?? ""),
      status: String(t.status ?? "pending"),
      activeForm: t.activeForm ? String(t.activeForm) : undefined,
    }))
    .filter((t) => t.content);
  return out.length ? out : null;
}

function short(s: string, n = 90): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** "Writing orders.py" (in progress) becomes "Wrote orders.py" once later work happened. */
export function pastTense(label: string): string {
  const m: [RegExp, string][] = [
    [/^Writing /, "Wrote "],
    [/^Editing /, "Edited "],
    [/^Reading /, "Read "],
    [/^Searching /, "Searched "],
    [/^Running /, "Ran "],
    [/^Installing /, "Installed "],
    [/^Messaging /, "Messaged "],
    [/^Asking /, "Asked "],
    [/^Checking /, "Checked "],
    [/^Reviewing /, "Reviewed "],
    [/^Planning /, "Planned "],
    [/^Handing off /, "Handed off "],
  ];
  for (const [re, rep] of m) if (re.test(label)) return label.replace(re, rep);
  return label;
}

export function deriveInsight(
  events: BotssEvent[],
  run: Run | null,
  fallback?: { label?: string | null; activity?: string | null },
): Insight {
  let label: string | null = null;
  let activity: Activity | null = null;
  let todos: Todo[] | null = null;
  const files = new Map<string, boolean>();
  const moments: Moment[] = [];
  let lastToolActivity: string | null = null;
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "run.tool") {
      const tool = String(d.tool ?? "");
      if (tool === "TodoWrite") {
        const t = parseTodos((d.input as { todos?: unknown } | undefined)?.todos);
        if (t) todos = t;
        continue;
      }
      label = (d.label as string | undefined) ?? e.summary;
      activity = (d.activity as Activity | undefined) ?? activity;
      lastToolActivity = (d.activity as string | undefined) ?? null;
      const file = d.file as string | null | undefined;
      if (file) {
        const wrote = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) || d.activity === "writing";
        files.delete(file);
        files.set(file, wrote || Boolean(files.get(file)));
      }
      if (d.activity !== "reading" && d.activity !== "searching")
        moments.push({
          id: e.id,
          ts: e.ts,
          text: label ?? e.summary,
          tone: d.activity === "talking" ? "talk" : "neutral",
        });
    } else if (e.type === "run.result") {
      if (lastToolActivity === "testing")
        moments.push({
          id: e.id,
          ts: e.ts,
          text: d.isError ? "Tests failed" : "Tests passed ✓",
          tone: d.isError ? "bad" : "ok",
        });
      else if (d.isError && /Botss guard/.test(String(d.text ?? "")))
        moments.push({ id: e.id, ts: e.ts, text: "Blocked by the Botss guard", tone: "bad" });
      lastToolActivity = null;
    } else if (e.type === "run.text") {
      const t = String(d.text ?? e.summary);
      if (t.trim()) moments.push({ id: e.id, ts: e.ts, text: `“${short(t, 110)}”`, tone: "talk" });
    } else if (e.type.startsWith("ask.") || e.type.startsWith("msg.")) {
      const to = String(d.to ?? "");
      const body = short(String(d.body ?? e.summary), 80);
      moments.push({
        id: e.id,
        ts: e.ts,
        text: e.type.startsWith("ask.") ? `Asked ${to}: ${body}` : `Told ${to}: ${body}`,
        tone: "talk",
      });
    } else if (e.type === "progress.note") {
      moments.push({ id: e.id, ts: e.ts, text: e.summary, tone: "neutral" });
    }
  }
  if (!todos && run) todos = parseTodos((run as Run & { todos?: unknown }).todos);
  if (!label)
    label = (run as (Run & { last_action?: string | null }) | null)?.last_action ?? fallback?.label ?? null;
  if (!activity)
    activity = ((run as (Run & { activity?: string | null }) | null)?.activity ??
      fallback?.activity ??
      null) as Activity | null;
  // Past tense for everything but the latest tool moment.
  const lastIdx = moments.map((m) => m.tone === "neutral" || m.tone === "talk").lastIndexOf(true);
  const shaped = moments.map((m, i) =>
    i < lastIdx && m.tone === "neutral" ? { ...m, text: pastTense(m.text) } : m,
  );
  return {
    label,
    activity,
    todos,
    files: [...files.entries()].reverse().map(([path, wrote]) => ({ path, wrote })),
    moments: shaped.slice(-5).reverse(),
    lastTs: events.at(-1)?.ts ?? null,
  };
}

export function todoProgress(todos: Todo[] | null): { done: number; total: number; current: Todo | null } {
  if (!todos?.length) return { done: 0, total: 0, current: null };
  return {
    done: todos.filter((t) => t.status === "completed").length,
    total: todos.length,
    current: todos.find((t) => t.status === "in_progress") ?? null,
  };
}

export const PLANNING_LABELS: Record<string, string> = {
  survey: "Reading your codebase",
  discover: "Preparing discovery questions",
  draft: "Writing the PRD",
  revise: "Revising the PRD",
  change: "Updating the PRD",
  direction: "Proposing visual directions",
  system: "Building the design system",
  screens: "Designing screens",
  architect: "Designing the architecture",
  plan: "Planning tasks",
  replan: "Updating the plan",
  answer: "Answering a teammate",
  integrate: "Fixing the integration",
  release: "Checking the release",
  journey: "Testing user journeys",
  audit: "Running a security audit",
};

export const STAGES = ["Building", "Review", "QA", "Done"] as const;

export function stageOf(t: Task | undefined | null): number {
  if (!t) return 0;
  if (t.status === "done") return 3;
  if (t.status === "qa") return 2;
  if (t.status === "review") return 1;
  return 0;
}
