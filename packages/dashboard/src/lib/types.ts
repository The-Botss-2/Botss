// Shapes returned by the Botss server API (packages/server/src/api.ts, service.ts). Kept loose on purpose:
// the dashboard must render whatever the server sends without crashing.

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

export const PHASE_LABELS: Record<Phase, string> = {
  idea: "Idea",
  discovery: "Discovery",
  prd_review: "PRD review",
  design_direction: "Direction",
  design: "Design",
  architecture_review: "Architecture",
  plan_review: "Plan review",
  build: "Build",
  release_review: "Release",
  done: "Done",
};

export const GATES = ["prd", "design_direction", "design", "architecture", "plan", "release"] as const;
export type Gate = (typeof GATES)[number];

/** Mirrors PHASE_GATE in packages/core/src/phases.ts. */
export const PHASE_GATE: Partial<Record<Phase, Gate>> = {
  prd_review: "prd",
  design_direction: "design_direction",
  architecture_review: "architecture",
  design: "design",
  plan_review: "plan",
  release_review: "release",
};

/** Document approved at each gate (GATE_DOC in core). */
export const DOC_GATE: Record<string, Gate> = {
  prd: "prd",
  architecture: "architecture",
  plan: "plan",
  release: "release",
  design: "design",
};

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

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  changes_requested: "Changes requested",
  qa: "QA",
  done: "Done",
};

export const PERMISSION_MODES = [
  "dontAsk",
  "acceptEdits",
  "default",
  "plan",
  "auto",
  "bypassPermissions",
] as const;

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

export interface Settings {
  max_concurrent_agents: number;
  daily_token_budget: number;
  reserve_percent: number;
  auto_resume_after_limit: boolean;
  gates: Record<string, boolean>;
  models: Record<string, string>;
  max_turns: Record<string, number>;
  default_max_turns: number;
  run_timeout_minutes: number;
  verify_timeout_minutes: number;
  permission_mode: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  team: Record<string, number>;
  checks: string[];
  qa_per_task: boolean;
  security_audit: boolean;
  /** The project is an existing codebase (set when it was opened). */
  existing?: boolean;
  max_review_rounds: number;
  max_verify_failures: number;
  port_base: number;
  scheduler_interval_ms: number;
}

export interface Alert {
  id: number;
  ts: string;
  text: string;
  task?: string | null;
}

export interface ProjectState {
  paused: boolean;
  pauseReason?: string | null;
  limitedUntil?: number | null;
  idea?: { text: string; stakes?: string; attachments: string[]; links: string[] } | null;
  designChoice?: string | null;
  previewRunning?: boolean;
  alerts?: Alert[];
}

export interface RoleDef {
  title: string;
  phase: string[];
  skills: string[];
  writes: string[];
  max_parallel: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  phase: Phase;
  settings: Settings;
  state: ProjectState;
  created_at: string;
  quota: { ok: boolean; reason?: string; allowance: number | null; usedToday: number };
  counts: Record<string, number>;
  activeRuns: number;
  openQuestions: number;
  previewUrl: string | null;
  roles: Record<string, RoleDef>;
  defaultStack: Record<string, unknown>;
  activeChange?: { id: string; status: ChangeStatus; text: string } | null;
}

export interface ProjectListItem {
  id: string;
  root: string;
  name?: string;
  open: boolean;
  phase: Phase | null;
  exists: boolean;
  [k: string]: unknown;
}

export interface TaskMeta {
  lastVerify?: { code: number; output: string; at: string };
  resumeStatus?: TaskStatus;
  [k: string]: unknown;
}

export interface Task {
  id: string;
  kind: "build" | "integrate" | "answer" | "planning" | "release";
  mode: string | null;
  title: string;
  role: string;
  story: string | null;
  covers: string[];
  after: string[];
  owns: string[];
  may_touch: string[];
  verify: string;
  size: "S" | "M" | "L";
  body?: string;
  source?: string;
  status: TaskStatus;
  assignee: string | null;
  review_round: number;
  qa_round: number;
  verify_failures: number;
  run_failures: number;
  base_sha: string | null;
  head_sha: string | null;
  branch: string | null;
  worktree: string | null;
  blocked_on: string | null;
  blocked_reason: string | null;
  done_status: string | null;
  hold: string | null;
  priority: number;
  parent: string | null;
  meta: TaskMeta;
  created_at: string;
  updated_at: string;
  bugs?: number;
}

export interface Run {
  id: string;
  agent: string;
  role: string;
  task: string | null;
  stage: string;
  mode: string;
  session_id: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  result_status: string | null;
  result_text: string | null;
  last_action: string | null;
  last_file: string | null;
}

export interface ReviewComment {
  id: number;
  file: string | null;
  line: number | null;
  severity: string;
  body: string;
  resolution: string | null;
}

export interface Review {
  id: number;
  task: string;
  round: number;
  reviewer: string | null;
  verdict: string;
  summary: string | null;
  content: string | null;
  created_at: string;
  comments: ReviewComment[];
}

export interface Handoff {
  id: number;
  task: string;
  agent: string | null;
  status: string;
  content: string;
  verify_output: string | null;
  head_sha: string | null;
  created_at: string;
}

export interface QaReport {
  id: number;
  task: string;
  round: number;
  agent: string | null;
  verdict: string;
  content: string;
  created_at: string;
}

export interface Bug {
  id: string;
  task: string;
  severity: string;
  title: string;
  content: string;
  status: string;
  reported_by?: string;
}

export interface Message {
  id: string;
  from_agent: string;
  from_role: string | null;
  to_addr: string;
  body: string;
  kind: string;
  thread: string | null;
  reply_to: string | null;
  task: string | null;
  created_at: string;
}

export interface TaskDetail {
  task: Task;
  reviews: Review[];
  bugs: Bug[];
  handoffs: Handoff[];
  qa: QaReport[];
  messages: Message[];
  runs: Run[];
  events: BotssEvent[];
}

export interface BatchOption {
  key: string;
  label: string;
  description?: string;
  [k: string]: unknown;
}

export interface BatchQuestion {
  id: string;
  topic?: string;
  question: string;
  options?: BatchOption[];
  recommended?: string;
  why_it_matters?: string;
  [k: string]: unknown;
}

export interface Batch {
  intro?: string;
  questions: BatchQuestion[];
  recommendation?: string;
  [k: string]: unknown;
}

export interface Question {
  id: string;
  message_id: string | null;
  from_agent: string;
  to_addr: string;
  task: string | null;
  run_id: string | null;
  kind: string;
  body: string;
  batch: Batch | null;
  status: "open" | "answered" | string;
  answer: unknown;
  answered_by: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface DocRow {
  name: string;
  path: string;
  owner_role: string | null;
  status: string;
  version: number;
  updated_at: string;
}

export interface DocComment {
  by: string;
  body: string;
  anchor?: string | null;
  ts: string;
}

export interface DocVersionMeta {
  id: number;
  version: number;
  submitted_by: string | null;
  status: string;
  comments: DocComment[];
  created_at: string;
}

export interface DocDetail extends DocRow {
  content: string | null;
  versions: DocVersionMeta[];
}

export interface DocVersion {
  id: number;
  doc: string;
  version: number;
  content: string;
  submitted_by: string | null;
  status: string;
  created_at: string;
}

export interface Agent {
  id: string;
  role: string;
  current_task: string | null;
  current_run: string | null;
  status: string;
  port_block: number;
  last_action: string | null;
  last_file: string | null;
  created_at: string;
  active: boolean;
  run: Run | null;
}

export interface PlanInfo {
  tasks: Task[];
  stats: {
    criticalPath: string[];
    criticalLength: number;
    peakLanes: number;
    byRole: Record<string, number>;
    peakByRole: Record<string, number>;
  } | null;
  estimate: {
    byRole: Record<string, { tasks: number; perRun: number; tokens: number }>;
    totalTokens: number;
  };
  team: Record<string, number>;
}

export interface UsageRow {
  tokens: number | null;
  cache_read: number | null;
  cost: number | null;
  turns: number | null;
  runs: number;
  day?: string;
  role?: string;
  task?: string;
}

export interface UsageInfo {
  byDay: UsageRow[];
  byRole: UsageRow[];
  byTask: UsageRow[];
  today: number;
  limits: BotssEvent[];
  settings: { daily_token_budget: number; reserve_percent: number };
}

export interface DesignInfo {
  choice: string | null;
  directions: Question[];
  tokens: unknown;
  screens: string[];
  directionPreviews?: string[];
}

export interface SkillsInfo {
  files: string[];
  roles: Record<string, string[]>;
}

export interface SkillFile {
  path: string;
  content: string;
  modified: boolean;
  hasDefault: boolean;
}

export type ChangeStatus = "pm" | "prd_review" | "replan" | "plan_review" | "applied" | "cancelled";

export interface ChangeRequest {
  id: string;
  text: string;
  status: ChangeStatus;
  created_at: string;
  updated_at: string;
}

export interface FsHome {
  home: string;
  sep: "/" | "\\";
  roots: string[];
  launchDir: string | null;
  launchIsProject: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  isBotss: boolean;
  isGit: boolean;
  hasFiles: boolean;
}

export interface FsList {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  /** The listed folder itself. */
  isBotss?: boolean;
  hasFiles?: boolean;
}

export interface TranscriptItem {
  kind: "text" | "tool" | "result" | "init" | "final";
  ts?: string;
  text?: string;
  tool?: string;
  input?: Record<string, unknown> | null;
  file?: string | null;
  isError?: boolean;
  toolUseId?: string | null;
}

export interface Transcript {
  run: Run | null;
  items: TranscriptItem[];
}
