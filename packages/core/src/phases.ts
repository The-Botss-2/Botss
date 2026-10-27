import type { Gate, Phase } from "./types.ts";

// Project phase machine. Transitions are driven by the orchestrator; the owner drives gates.

export const PHASE_ORDER: Phase[] = [
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
];

export const PHASE_LABELS: Record<Phase, string> = {
  idea: "Idea",
  discovery: "Discovery",
  prd_review: "PRD review",
  design_direction: "Design direction",
  design: "Design",
  architecture_review: "Architecture review",
  plan_review: "Plan review",
  build: "Build",
  release_review: "Release review",
  done: "Done",
};

/** The gate (if any) whose approval moves the project out of a phase. */
export const PHASE_GATE: Partial<Record<Phase, Gate>> = {
  prd_review: "prd",
  design_direction: "design_direction",
  architecture_review: "architecture",
  plan_review: "plan",
  release_review: "release",
};

/** Document approved at each gate. */
export const GATE_DOC: Record<Gate, string | null> = {
  prd: "prd",
  design_direction: null,
  architecture: "architecture",
  plan: "plan",
  release: "release",
};

export function nextPhase(p: Phase): Phase {
  const i = PHASE_ORDER.indexOf(p);
  return PHASE_ORDER[Math.min(i + 1, PHASE_ORDER.length - 1)]!;
}

export function canAdvance(from: Phase, to: Phase): boolean {
  const a = PHASE_ORDER.indexOf(from);
  const b = PHASE_ORDER.indexOf(to);
  // Forward one step, or back to an earlier phase (replan / revise).
  return b === a + 1 || b <= a;
}

export function phaseIndex(p: Phase): number {
  return PHASE_ORDER.indexOf(p);
}
