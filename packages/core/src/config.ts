import YAML from "yaml";
import { z } from "zod";
import { GATES, ROLES, type Gate, type Role } from "./types.ts";

const roleSchema = z.object({
  title: z.string(),
  phase: z.array(z.string()).default([]),
  skills: z.array(z.string()),
  writes: z.array(z.string()).default([]),
  max_parallel: z.number().int().min(1).default(1),
});

const rolesFileSchema = z.object({
  scratch_paths: z.array(z.string()).default([]),
  roles: z.record(z.string(), roleSchema),
  default_stack: z.record(z.string(), z.unknown()).default({}),
});

export type RoleDef = z.infer<typeof roleSchema>;
export type RolesFile = z.infer<typeof rolesFileSchema>;

export function parseRolesYaml(text: string): RolesFile {
  const parsed = rolesFileSchema.parse(YAML.parse(text));
  for (const name of Object.keys(parsed.roles)) {
    if (!(ROLES as readonly string[]).includes(name)) throw new Error(`roles.yaml: unknown role "${name}"`);
  }
  return parsed;
}

/**
 * Default tools for headless runs. Agents get the shell like a developer using Claude Code; safety comes from the
 * Botss guard hook (write paths, git, deletes, network, credentials), which runs before every tool call. An
 * allowlist of command prefixes denied ordinary commands (npm install, pipes, python -m ...) and wasted turns.
 */
export const DEFAULT_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "Bash"];

/** The pre-0.2 prefix allowlist; projects still on it are upgraded to the default above. */
export const LEGACY_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "MultiEdit",
  "TodoWrite",
  "Bash(botss *)",
  "Bash(git *)",
  "Bash(uv *)",
  "Bash(pnpm *)",
  "Bash(npx *)",
  "Bash(node *)",
  "Bash(python *)",
  "Bash(docker compose *)",
  "Bash(make *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(mkdir *)",
  "Bash(cd *)",
  "Bash(curl *)",
];

/** Web access and sub-agents stay off: they leave the guard's view or multiply token use. */
export const DEFAULT_DISALLOWED_TOOLS = ["Bash(git push --force *)", "Bash(git push -f *)", "WebFetch", "WebSearch", "Task", "Agent"];

export const WORKSPACE_MODES = ["direct", "isolated"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const PERMISSION_MODES = ["dontAsk", "acceptEdits", "default", "plan", "auto", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const settingsSchema = z.object({
  /**
   * direct: agents edit the project folder itself (like Claude Code); Botss commits each finished task.
   * isolated: each task gets its own git worktree and branch, merged into botss/integration.
   */
  workspace: z.enum(WORKSPACE_MODES).default("direct"),
  max_concurrent_agents: z.number().int().min(1).max(32).default(3),
  /** 0 = no Botss limit (Claude Code's own usage limits still apply, and Botss pauses on them). */
  daily_token_budget: z.number().int().min(0).default(0),
  /** Percentage of the daily budget kept for the owner's own use. Botss stops starting runs above (100 - reserve)%. */
  reserve_percent: z.number().min(0).max(100).default(20),
  auto_resume_after_limit: z.boolean().default(true),
  gates: z
    .record(z.enum(GATES), z.boolean())
    .default(Object.fromEntries(GATES.map((g) => [g, true])) as Record<Gate, boolean>),
  models: z.record(z.string(), z.string()).default({}),
  max_turns: z.record(z.string(), z.number().int().min(1)).default({}),
  default_max_turns: z.number().int().min(1).default(80),
  run_timeout_minutes: z.number().min(0.01).default(45),
  verify_timeout_minutes: z.number().min(0.01).default(15),
  permission_mode: z.enum(PERMISSION_MODES).default("dontAsk"),
  allowed_tools: z.array(z.string()).default(DEFAULT_ALLOWED_TOOLS),
  disallowed_tools: z.array(z.string()).default(DEFAULT_DISALLOWED_TOOLS),
  /** Team counts from the team builder (agents per role). */
  team: z.record(z.string(), z.number().int().min(0)).default({}),
  /** Check commands run on the integration branch after each merge (from T000/T001 handoffs). */
  checks: z.array(z.string()).default([]),
  qa_per_task: z.boolean().default(true),
  /** How to run the app for the Preview screen (empty: from the tech lead's notes or the project files). */
  preview_command: z.string().default(""),
  preview_url: z.string().default(""),
  /** The project folder already had code at `botss init`: survey it first, no scaffold. */
  existing: z.boolean().default(false),
  security_audit: z.boolean().default(false),
  max_review_rounds: z.number().int().min(1).default(3),
  max_verify_failures: z.number().int().min(1).default(3),
  port_base: z.number().int().min(1024).max(60000).default(21000),
  scheduler_interval_ms: z.number().int().min(50).default(2000),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

export function mergeSettings(base: Settings, patch: unknown): Settings {
  const merged = { ...base, ...(patch as object) };
  return settingsSchema.parse(merged);
}

export function roleCap(roles: RolesFile, settings: Settings, role: Role): number {
  // The team builder count wins once the owner has set it; roles.yaml max_parallel is the default.
  const team = settings.team[role];
  return team !== undefined && team > 0 ? team : (roles.roles[role]?.max_parallel ?? 1);
}

/** Initial `.botss/config.yaml` written by `botss init`. */
export function initialConfigYaml(roles: RolesFile, opts: { existing?: boolean; workspace?: WorkspaceMode } = {}): string {
  const s = defaultSettings();
  const doc = {
    "# note": "Initial Botss settings. Live settings are edited in the dashboard and stored in .botss/botss.db.",
    existing: Boolean(opts.existing),
    workspace: opts.workspace ?? "direct",
    max_concurrent_agents: s.max_concurrent_agents,
    daily_token_budget: s.daily_token_budget,
    reserve_percent: s.reserve_percent,
    gates: s.gates,
    permission_mode: s.permission_mode,
    default_max_turns: s.default_max_turns,
    run_timeout_minutes: s.run_timeout_minutes,
    team: Object.fromEntries(Object.entries(roles.roles).map(([k, v]) => [k, v.max_parallel])),
    default_stack: roles.default_stack,
  };
  return YAML.stringify(doc);
}

export function parseConfigYaml(text: string): Partial<Settings> {
  const raw = (YAML.parse(text) ?? {}) as Record<string, unknown>;
  const allowed = Object.keys(settingsSchema.shape);
  return Object.fromEntries(Object.entries(raw).filter(([k]) => allowed.includes(k))) as Partial<Settings>;
}

export type { Role };
