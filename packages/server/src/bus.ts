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
    task: ["tasks"],
    plan: ["tasks", "docs", "project"],
    run: ["runs", "agents"],
    agent: ["agents"],
    msg: ["messages"],
    ask: ["messages", "questions", "tasks"],
    answer: ["messages", "questions", "tasks"],
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
  };
  return map[head] ?? ["project"];
}

export class EventBus extends EventEmitter {
  publish(projectId: string, ev: BotssEvent): void {
    this.emit("event", projectId, ev);
  }
}
