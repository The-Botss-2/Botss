// Domain types shared by the server, CLI, fake-claude and (as plain JSON) the dashboard.

export const ROLES = [
  "pm",
  "tech-lead",
  "designer",
  "backend",
  "frontend",
  "qa",
  "reviewer",
  "devops",
  "security",
] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export const TASK_STATUSES = [
  "todo",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "changes_requested",
  "qa",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** build: from the plan. integrate: merge conflict / failing checks. answer: a teammate question routed to a role.
 * planning: PM / designer / tech lead document runs. release: QA journey + security audit before release. */
export type TaskKind = "build" | "integrate" | "answer" | "planning" | "release";

export const DONE_STATUSES = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT"] as const;
export type DoneStatus = (typeof DONE_STATUSES)[number];

export const SEVERITIES = ["blocker", "major", "minor", "trivial"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PHASES = [
  "idea",
  "discovery",
  "prd_review",
  "design_direction",
  "design",
  "architecture_review",
  "plan_review",
  "build",
  "release_review",
  "done",
] as const;
export type Phase = (typeof PHASES)[number];

export const GATES = ["prd", "design_direction", "design", "architecture", "plan", "release"] as const;
export type Gate = (typeof GATES)[number];

export type RunMode =
  | "discover"
  | "draft"
  | "revise"
  | "direction"
  | "system"
  | "screens"
  | "architect"
  | "plan"
  | "answer"
  | "integrate"
  | "scaffold"
  | "implement"
  | "fix"
  | "review"
  | "verify"
  | "ruling"
  | "journey"
  | "release"
  | "audit"
  | "survey"
  | "change"
  | "replan"
  | "triage";

export type DocStatus = "draft" | "submitted" | "approved" | "changes_requested";

/** A task as declared in a task file (`.botss/tasks/*.md`). */
export interface TaskSpec {
  id: string;
  title: string;
  role: Role;
  story?: string;
  covers: string[];
  after: string[];
  owns: string[];
  may_touch: string[];
  verify: string;
  size: "S" | "M" | "L";
  body: string;
  /** Raw source text, frontmatter included. */
  source: string;
  file?: string;
}

export interface PlanProblem {
  code: "missing_field" | "unknown_after" | "cycle" | "role" | "collision" | "duplicate_id" | "parse";
  tasks: string[];
  message: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function emptyUsage(): UsageTotals {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

/** Tokens that count against the daily budget. Cache reads are cheap and very large, so they are tracked but not counted. */
export function budgetTokens(u: UsageTotals): number {
  return u.input_tokens + u.output_tokens + u.cache_creation_input_tokens;
}
