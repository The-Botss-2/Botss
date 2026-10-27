import type { Settings } from "./config.ts";

export interface QuotaState {
  usedToday: number;
  /** Epoch ms until which Claude Code reported a usage limit. */
  limitedUntil?: number | null;
}

export interface QuotaDecision {
  ok: boolean;
  reason?: string;
  allowance: number;
}

/** Botss may start runs while today's budget tokens stay under (100 - reserve)% of the daily budget. */
export function quotaCheck(settings: Settings, state: QuotaState, now = Date.now()): QuotaDecision {
  const allowance = settings.daily_token_budget > 0 ? Math.floor((settings.daily_token_budget * (100 - settings.reserve_percent)) / 100) : Infinity;
  if (state.limitedUntil && state.limitedUntil > now) {
    return { ok: false, reason: `Claude Code usage limit; resumes at ${new Date(state.limitedUntil).toISOString()}`, allowance };
  }
  if (state.usedToday >= allowance) {
    return { ok: false, reason: `daily budget reached (${state.usedToday} of ${allowance} tokens Botss may use)`, allowance };
  }
  return { ok: true, allowance };
}

/** Default tokens per run by role, used for estimates before there is history. */
export const DEFAULT_RUN_TOKENS: Record<string, number> = {
  pm: 120_000,
  "tech-lead": 250_000,
  designer: 180_000,
  backend: 220_000,
  frontend: 220_000,
  qa: 160_000,
  reviewer: 90_000,
  devops: 150_000,
  security: 150_000,
};

export interface Estimate {
  byRole: Record<string, { tasks: number; perRun: number; tokens: number }>;
  totalTokens: number;
}

/** Estimate = task count by role x average run cost by role (history first, defaults otherwise), plus review and QA runs per task. */
export function estimateBuild(tasksByRole: Record<string, number>, avgByRole: Record<string, number>, qaPerTask = true): Estimate {
  const per = (r: string) => avgByRole[r] ?? DEFAULT_RUN_TOKENS[r] ?? 150_000;
  const byRole: Estimate["byRole"] = {};
  const add = (role: string, tasks: number) => {
    const cur = byRole[role] ?? { tasks: 0, perRun: per(role), tokens: 0 };
    cur.tasks += tasks;
    cur.tokens = cur.tasks * cur.perRun;
    byRole[role] = cur;
  };
  let n = 0;
  for (const [role, count] of Object.entries(tasksByRole)) {
    add(role, count);
    n += count;
  }
  add("reviewer", n);
  if (qaPerTask) add("qa", n);
  const totalTokens = Object.values(byRole).reduce((a, b) => a + b.tokens, 0);
  return { byRole, totalTokens };
}
