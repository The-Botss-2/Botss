import { ROLES } from "./types";

export const ROLE_LABELS: Record<string, string> = {
  pm: "Product manager",
  "tech-lead": "Tech lead",
  designer: "Designer",
  backend: "Backend",
  frontend: "Frontend",
  qa: "QA",
  reviewer: "Reviewer",
  devops: "DevOps",
  security: "Security",
};

/** Short role codes for dense places (board cards, feed gutter). */
export const ROLE_CODES: Record<string, string> = {
  pm: "PM",
  "tech-lead": "TL",
  designer: "DS",
  backend: "BE",
  frontend: "FE",
  qa: "QA",
  reviewer: "RV",
  devops: "OP",
  security: "SC",
};

/** "backend-2" -> "backend"; "human" / "orchestrator" / "botss" -> special. */
export function roleOf(actorOrRole: string | null | undefined): string {
  if (!actorOrRole) return "system";
  const a = actorOrRole.replace(/^@/, "");
  if ((ROLES as readonly string[]).includes(a)) return a;
  const base = a.replace(/-\d+$/, "");
  if ((ROLES as readonly string[]).includes(base)) return base;
  if (a === "human" || a === "owner") return "human";
  return "system";
}

export function roleColor(role: string | null | undefined): string {
  const r = roleOf(role);
  return `var(--role-${r})`;
}

export function statusColor(status: string): string {
  return `var(--st-${status}, var(--ink-3))`;
}
