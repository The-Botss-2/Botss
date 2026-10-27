import type { Role } from "./types.ts";

export type Identity =
  | { kind: "human" }
  | { kind: "agent"; agent: string; role: Role; task: string | null; runId: string };

export type Action =
  | "read" // whoami, task show/list, doc list/show, inbox, decision list/show, plan check
  | "task.own" // start, block, done on the caller's own task
  | "task.unblock"
  | "progress"
  | "msg"
  | "ask"
  | "reply"
  | "decision"
  | "doc.submit"
  | "plan.submit"
  | "review"
  | "qa"
  | "bug.create";

export interface Decision {
  ok: boolean;
  reason?: string;
}

const REVIEW_ROLES: Role[] = ["reviewer", "qa", "designer"];
const BUG_ROLES: Role[] = ["qa", "reviewer", "designer", "security"];

/** Which role may submit which document. Keys are doc names or prefixes ending in "/". */
const DOC_OWNERS: [string, Role[]][] = [
  ["prd", ["pm"]],
  ["discovery/", ["pm"]],
  ["architecture", ["tech-lead"]],
  ["plan", ["tech-lead"]],
  ["contracts/design-tokens.json", ["designer", "tech-lead"]],
  ["contracts/", ["tech-lead"]],
  ["design", ["designer"]],
  ["design/", ["designer"]],
  ["decisions/", ["tech-lead", "pm", "designer", "backend", "frontend", "qa", "devops", "security", "reviewer"]],
  ["security/", ["security"]],
  ["qa/", ["qa"]],
];

export function docOwners(name: string): Role[] | null {
  for (const [key, roles] of DOC_OWNERS) {
    if (key.endsWith("/") ? name.startsWith(key) : name === key) return roles;
  }
  return null;
}

export function authorize(id: Identity, action: Action, ctx: { task?: string; doc?: string } = {}): Decision {
  if (id.kind === "human") return { ok: true };
  const deny = (reason: string): Decision => ({ ok: false, reason });
  switch (action) {
    case "read":
    case "progress":
    case "msg":
    case "ask":
    case "reply":
    case "decision":
      return { ok: true };
    case "task.own":
      if (!ctx.task) return deny("no task given");
      if (id.task !== ctx.task) {
        return deny(`agent ${id.agent} may only change its own task (${id.task ?? "none"}), not ${ctx.task}`);
      }
      return { ok: true };
    case "task.unblock":
      if (ctx.task && id.task === ctx.task) return { ok: true };
      if (id.role === "tech-lead") return { ok: true };
      return deny("only the task's own agent or the tech lead may unblock a task");
    case "doc.submit": {
      const owners = ctx.doc ? docOwners(ctx.doc) : null;
      if (!owners) return deny(`unknown document "${ctx.doc ?? ""}"`);
      if (!owners.includes(id.role)) return deny(`role ${id.role} may not submit ${ctx.doc}; owner: ${owners.join(" or ")}`);
      return { ok: true };
    }
    case "plan.submit":
      return id.role === "tech-lead" ? { ok: true } : deny("only the tech lead may submit the plan");
    case "review":
      return REVIEW_ROLES.includes(id.role) ? { ok: true } : deny(`review commands are for ${REVIEW_ROLES.join(", ")} only`);
    case "qa":
      return id.role === "qa" ? { ok: true } : deny("qa commands are for the QA role only");
    case "bug.create":
      return BUG_ROLES.includes(id.role) ? { ok: true } : deny(`bug create is for ${BUG_ROLES.join(", ")} only`);
  }
}
