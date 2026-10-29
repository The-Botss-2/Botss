import { EventEmitter } from "node:events";

export interface BotssEvent {
  id: number;
  ts: string;
  type: string;
  actor: string | null;
  role: string | null;
  task: string | null;
  run_id: string | null;
  summary: string;
  data: Record<string, unknown>;
}

/** Query topics the dashboard should refetch for an event type. */
export function topicsFor(type: string): string[] {
  const head = type.split(".")[0]!;
  const map: Record<string, string[]> = {
    task: ["tasks", "project"],
    plan: ["tasks", "docs", "project"],
    run: ["runs", "agents", "project"],
    agent: ["agents"],
    msg: ["messages"],
    ask: ["messages", "questions", "tasks", "project"],
    answer: ["messages", "questions", "tasks", "project"],
    decision: ["decisions"],
    doc: ["docs", "project"],
    review: ["tasks", "reviews"],
    qa: ["tasks", "reviews"],
    bug: ["tasks", "reviews"],
    merge: ["tasks", "project"],
    checks: ["tasks"],
    guard: ["agents"],
    phase: ["project", "docs"],
    quota: ["project", "usage"],
    project: ["project"],
    settings: ["project"],
    progress: ["tasks"],
    handoff: ["tasks"],
    alert: ["project", "questions"],
    design: ["docs", "project"],
    idea: ["project", "docs"],
    preview: ["project"],
    skills: ["skills"],
    change: ["project", "docs", "changes", "tasks"],
    memory: ["memory"],
    gate: ["project", "docs", "needs"],
  };
  return map[head] ?? ["project"];
}

export class EventBus extends EventEmitter {
  publish(projectId: string, ev: BotssEvent): void {
    this.emit("event", projectId, ev);
  }
}
