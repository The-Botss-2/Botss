import { globsOverlap } from "./globs.ts";
import type { Role, TaskKind, TaskStatus } from "./types.ts";

// Pure scheduling decisions. The server's orchestrator loop feeds in a snapshot and executes the result.

export interface SchedTask {
  id: string;
  kind: TaskKind;
  role: Role;
  status: TaskStatus;
  after: string[];
  owns: string[];
  /** A run for this task is currently active. */
  running: boolean;
  /** Direct mode: the task's unfinished edits are in the shared folder (in review, QA, ...), so its files stay taken. */
  occupies?: boolean;
  /** Set when the task waits on a question, a cooldown, or the owner. */
  hold?: boolean;
  /** Lower runs first. */
  priority?: number;
}

export interface SchedInput {
  tasks: SchedTask[];
  /** Active runs by role, including planning/answer runs. */
  runningByRole: Partial<Record<Role, number>>;
  roleCaps: Partial<Record<Role, number>>;
  globalCap: number;
  quotaOk: boolean;
  paused: boolean;
}

export type SchedAction =
  | { type: "promote"; task: string } // todo -> ready
  | { type: "start"; task: string; role: Role; stage: Stage };

/** Which run a task needs next, given its status. */
export type Stage = "implement" | "fix" | "review" | "verify";

export function stageFor(status: TaskStatus, kind: TaskKind, role: Role): { stage: Stage; role: Role } | null {
  switch (status) {
    case "ready":
    case "in_progress":
      return { stage: "implement", role };
    case "changes_requested":
      return { stage: "fix", role };
    case "review":
      return kind === "build" ? { stage: "review", role: "reviewer" } : null;
    case "qa":
      return kind === "build" ? { stage: "verify", role: "qa" } : null;
    default:
      return null;
  }
}

export function readyToPromote(task: SchedTask, byId: Map<string, SchedTask>): boolean {
  return task.status === "todo" && task.after.every((d) => byId.get(d)?.status === "done");
}

export function schedule(input: SchedInput): SchedAction[] {
  const actions: SchedAction[] = [];
  const byId = new Map(input.tasks.map((t) => [t.id, t]));

  for (const t of input.tasks) {
    if (readyToPromote(t, byId)) {
      actions.push({ type: "promote", task: t.id });
      t.status = "ready";
    }
  }
  if (input.paused || !input.quotaOk) return actions;

  const running = { ...input.runningByRole };
  let total = Object.values(running).reduce((a, b) => a + (b ?? 0), 0);
  // Owned paths of tasks with an active implementation-type run, for the defense-in-depth overlap check.
  const activeOwns = input.tasks.filter((t) => t.running || t.occupies).map((t) => ({ id: t.id, owns: t.owns }));

  const candidates = input.tasks
    .filter((t) => !t.running && !t.hold)
    .map((t) => ({ t, next: stageFor(t.status, t.kind, t.role) }))
    .filter((x): x is { t: SchedTask; next: { stage: Stage; role: Role } } => x.next !== null)
    // Finish work in flight before starting new work: verify, review, fix, then implement. Then by priority, id.
    .sort((a, b) => {
      const order: Record<Stage, number> = { verify: 0, review: 1, fix: 2, implement: 3 };
      return (
        order[a.next.stage] - order[b.next.stage] ||
        (a.t.priority ?? 100) - (b.t.priority ?? 100) ||
        a.t.id.localeCompare(b.t.id, undefined, { numeric: true })
      );
    });

  for (const { t, next } of candidates) {
    if (total >= input.globalCap) break;
    const cap = input.roleCaps[next.role] ?? 1;
    if ((running[next.role] ?? 0) >= cap) continue;
    if (next.stage === "implement" || next.stage === "fix") {
      const clash = activeOwns.find((a) => a.id !== t.id && t.owns.some((g) => a.owns.some((h) => globsOverlap(g, h).overlap)));
      if (clash) continue;
      activeOwns.push({ id: t.id, owns: t.owns });
    }
    actions.push({ type: "start", task: t.id, role: next.role, stage: next.stage });
    running[next.role] = (running[next.role] ?? 0) + 1;
    total++;
  }
  return actions;
}

// ---------------------------------------------------------------------------------------------------------
// Task status transitions allowed through the service layer (agents and orchestrator).

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["ready", "blocked"],
  ready: ["in_progress", "blocked", "review", "todo", "done"],
  in_progress: ["review", "blocked", "ready", "changes_requested", "done", "qa"],
  blocked: ["ready", "in_progress", "changes_requested", "review", "qa", "todo"],
  review: ["qa", "changes_requested", "blocked", "done", "ready"],
  changes_requested: ["in_progress", "review", "blocked", "ready", "qa", "done"],
  qa: ["done", "changes_requested", "blocked", "ready"],
  done: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}
