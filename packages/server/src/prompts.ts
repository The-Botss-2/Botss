import type { RolesFile } from "@botss/core";
import fs from "node:fs";
import path from "node:path";
import type { Row } from "@botss/core";
import type { TaskRow } from "./service.ts";

// Prompt assembly. system.md = a Botss header + the role's SKILL.md bodies (roles.yaml order). It is identical
// for every run of a role (no agent id, task, or mode in it), so Claude Code's prompt cache is reused across
// runs and agents. Everything run-specific goes in the run prompt (user message), which stays lean: who you
// are, the task file, a few unread messages, and pointers to files by path.

export function stripFrontmatter(md: string): string {
  return md.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export function readSkill(skillsDir: string, name: string): string | null {
  const f = path.join(skillsDir, name, "SKILL.md");
  return fs.existsSync(f) ? stripFrontmatter(fs.readFileSync(f, "utf8")) : null;
}

export interface SystemPromptInput {
  roleTitle: string;
  project: string;
  skills: string[];
  skillsDir: string;
  /** Direct mode: the team shares the project folder and Botss handles everything git used to do. */
  direct?: boolean;
}

const DIRECT_NOTE = [
  "**How this project works (overrides your skills where they differ):** the whole team works directly in the",
  "owner's project folder, at the same time, like colleagues sharing one machine. There are no worktrees, branches,",
  "or commits: never run `git add`, `commit`, `stash`, `reset`, `checkout`, or `merge` (read-only `git status`,",
  "`diff`, and `log` are fine). Ignore skill instructions about committing; `botss task done` does not need a commit.",
  "Edit only your task's files: teammates are editing theirs right now. Botss tracks what each task changed for review.",
  "",
].join("\n");

export function buildSystemPrompt(i: SystemPromptInput): string {
  const header = [
    "# Botss agent run",
    "",
    `You are the ${i.roleTitle} on the Botss team building **${i.project}**. Your agent id, task, and mode are in the first message.`,
    "",
    "You run headless: nobody reads this conversation. Everything the team needs goes through the `botss` CLI or into files.",
    `Your skills are below. Their \`references/\` and \`templates/\` live under \`${i.skillsDir.replace(/\\/g, "/")}/<skill>/\``,
    `(for example \`${i.skillsDir.replace(/\\/g, "/")}/team-protocol/references/botss-cli.md\`). Open a reference only when the skill tells you to.`,
    "Project conventions live in `.botss/docs/architecture.md` (Conventions section) once the architecture exists.",
    "If `.botss/docs/codebase.md` exists, this is an existing codebase: follow its conventions and change only what your task asks.",
    "A guard hook enforces your write paths and blocks unsafe commands; if it blocks you, do not try to get around it: ask.",
    "",
    "**Build only what the owner asked for.** Do not add features, screens, endpoints, settings, or polish that the idea, the",
    "approved PRD, or your task does not ask for. If something seems missing, ask (or note it under Out of scope / Later); never",
    "add it silently. Assumptions you must make are written down where the owner will see them.",
    "",
    ...(i.direct ? [DIRECT_NOTE] : []),
  ].join("\n");
  const bodies = i.skills
    .map((s) => {
      const body = readSkill(i.skillsDir, s);
      return body ? `\n\n---\n\n<!-- skill: ${s} -->\n${body}` : `\n\n<!-- skill ${s} not found -->`;
    })
    .join("");
  return header + bodies + "\n";
}

export const MODE_GUIDE: Record<string, string> = {
  triage:
    "Mode: triage. Before any process starts, decide how much process this request needs, like a lead sizing a ticket. Keep this run short: read `.botss/docs/idea.md` and only the few files needed to understand where the change goes (do not survey the whole project). Pick one track:\n" +
    "- **quick**: small and clear, 1 to 3 small tasks, no new data model, API, or screens to design. Examples: UI or style tweaks, copy changes, a small bug fix, a config change.\n" +
    "- **standard**: a real feature that needs a short spec, but no visual direction or architecture change.\n" +
    "- **full**: a new product, or a large feature with new data, screens, or architecture.\n" +
    "When unsure between two tracks, pick the smaller one; the owner can ask for more.\n" +
    "For **quick**: write the task files in `.botss/tasks/` now (short: goal, `owns` with the exact files, acceptance criteria, a `verify` command that really checks the change; continue numbering after the highest existing task ID; leave existing task files unchanged), then `botss plan submit .botss/tasks/`.\n" +
    "For every track: write `.botss/docs/triage.md` whose first line is `track: quick`, `track: standard`, or `track: full`, followed by two to four plain sentences for the owner: what you understood and what will happen next. Then `botss doc submit triage` and finish.",
  survey:
    "Mode: survey. This project is an existing codebase. Read it narrowly: README, package manifests and lockfiles, the top-level layout, CI config, a few representative source and test files. Do not change code. Write `.botss/docs/codebase.md`: what the app does, stack and versions, folder layout, how to run it, conventions new code must follow (naming, errors, data access, UI components), risky areas, a `## Checks` section with the exact test, lint, type check, and build commands (one per line, runnable without make), and a `## Preview` section with `command: <how to start the app for a person to try it>` and `url: <where it opens>` (Botss runs it for the owner's Preview screen; the env var PORT holds a free port you may use). Commit, then `botss doc submit codebase` and finish.",
  discover:
    "Mode: discover. Read the owner's request in `.botss/docs/idea.md` (and anything in `.botss/docs/attachments/`; for an existing codebase also `.botss/docs/codebase.md`). Ask only what changes the result; do not ask about things the owner already said. Write your clarifying questions as one batch to `.botss/docs/discovery/questions.json` and post it with `botss ask @human --batch .botss/docs/discovery/questions.json`. Then finish your run with a one-line summary.",
  draft:
    "Mode: draft. Write the PRD to `.botss/docs/prd.md` from `.botss/skills/product-manager/templates/prd.md`, using only the idea and the owner's answers. Every FR must trace to something the owner said; ideas of your own go under Out of scope / Later, not into the FRs. Then `botss doc submit prd` and finish.",
  revise: "Mode: revise. The owner requested changes to the PRD. Address every comment below in `.botss/docs/prd.md` (and nothing else), then `botss doc submit prd` and finish.",
  change:
    "Mode: change. The owner sent a change request (below) in the middle of the project. Update `.botss/docs/prd.md` for exactly that change: add or modify FRs and acceptance criteria, mark removed ones as removed, and add a `## Changelog` entry (change id, date, what changed and why). Do not change anything the request does not touch. Ask `@human` only if the request is ambiguous in a way that changes the result. Commit, then `botss doc submit prd` and finish.",
  direction:
    "Mode: direction. Read the approved PRD (`.botss/docs/prd.md`). Propose 2 to 3 visual directions as one batch (`.botss/docs/design/directions.json`, same format as a question batch: one question whose options are the directions, with keys A, B, C; put palette, type, and mood in each option's label). For each option also write a self-contained preview page `.botss/docs/design/directions/<key>.html` (for example `A.html`: the app's main screen in that direction, inline CSS, no external scripts or fonts) so the owner can see it before choosing. Commit, post with `botss ask @human --batch .botss/docs/design/directions.json`, and finish.",
  system:
    "Mode: system. Build the chosen direction into `.botss/docs/contracts/design-tokens.json`, the Tailwind v4 theme, and `.botss/docs/design/DESIGN.md`. Commit. Then finish (screens come in the next run).",
  screens:
    "Mode: screens. Write one spec and one HTML mockup per screen the PRD lists under `.botss/docs/design/screens/` (mockups as `<screen>.html`, self-contained, inline CSS, no external scripts). Design only the screens and states the PRD needs. Commit, then `botss doc submit design` and finish. The owner reviews the screens before the architecture starts; if comments are included below, address every one.",
  architect:
    "Mode: architect. Write `.botss/docs/architecture.md` and the contracts in `.botss/docs/contracts/` from the approved PRD and design (and `.botss/docs/codebase.md` if it exists: extend the existing architecture, do not replace it). Run the architecture checks, commit, then `botss doc submit architecture` and finish.",
  plan:
    "Mode: plan. Write the task files in `.botss/tasks/` and `.botss/docs/plan-summary.md` (team recommendation, critical path, quota estimate). Every task must trace to an approved FR. For an existing codebase there is no scaffold: no T000/T001 unless something they would create is missing, and verify commands come from `.botss/docs/codebase.md`. Run `botss plan check .botss/tasks/` until clean, commit, then `botss plan submit .botss/tasks/` and finish.",
  replan:
    "Mode: replan. The owner approved a PRD change (below). Update contracts and architecture only where the change needs it, then update the plan: add new task files with new IDs (continue after the highest existing ID), edit only tasks that are still todo, and never edit, renumber, or delete the files of tasks that started or finished (`botss task list` shows statuses). Point `after` at existing tasks you build on. Update `.botss/docs/plan-summary.md` with a short section for this change. Run `botss plan check .botss/tasks/`, commit, then `botss plan submit .botss/tasks/` and finish.",
  answer:
    "Mode: answer. Teammates asked you the questions below. Answer each with one short `botss reply <message-id> \"...\"` (point to files instead of pasting them). Update a contract or record a decision only if the answer changes one (and commit). Then finish.",
  integrate:
    "Mode: integrate. A merge into `botss/integration` failed. Your worktree is on a fresh branch from the integration head. Merge the task branch named below (`git merge --no-ff <branch>`), resolve to what the contract says, run the checks, commit, write your handoff, and `botss task done $BOTSS_TASK --status DONE --handoff .botss/handoffs/$BOTSS_TASK.md`.",
  repair:
    "Mode: repair. The project's checks failed after a teammate's task finished (details below). Find the cause, fix it with the smallest change inside this task's files, run the checks, write your handoff, and `botss task done $BOTSS_TASK --status DONE --handoff .botss/handoffs/$BOTSS_TASK.md`. If the fix belongs in files you do not own, message their owner.",
  ruling:
    "Mode: ruling. This task used all its review rounds. Read the review comments below and the code, decide what remains, make the minimal fixes within the task's owned paths, and finish it with `botss task done`. Record your ruling in the handoff.",
  journey: "Mode: journey. Write and run the committed Playwright journey tests for the PRD's core journeys, then `botss qa pass` or `botss qa fail` on your task.",
  release:
    "Mode: release. Run the full suite and every journey on the merged integration branch. Write the release QA report, then `botss qa pass $BOTSS_TASK --report <file>` (go) or `botss qa fail $BOTSS_TASK --report <file>` (no-go, with bugs).",
  audit:
    "Mode: audit. Audit the merged branch per your skill. File bugs with `botss bug create --task $BOTSS_TASK ...` for real findings, write `.botss/docs/security/audit.md`, commit, and finish with `botss task done $BOTSS_TASK --status DONE --handoff .botss/handoffs/$BOTSS_TASK.md`.",
};

/** Unread messages shown in a run prompt: the latest few, each capped. The agent can run `botss inbox` for more. */
const INBOX_LIMIT = 8;
const INBOX_CHARS = 600;

export interface RunPromptInput {
  mode: string;
  stage: string;
  task: TaskRow | null;
  inbox: Row[];
  extra?: string[];
  handoff?: string | null;
  diffStat?: string | null;
  agent?: string;
  roleTitle?: string;
}

export function buildRunPrompt(i: RunPromptInput): string {
  const parts: string[] = [];
  if (i.agent) {
    const task = i.task && i.task.kind !== "planning" ? `Task: ${i.task.id}` : "Planning run (no board task)";
    parts.push(`You are **${i.agent}** (${i.roleTitle ?? "agent"}). ${task} · Mode: \`${i.mode}\``);
  }
  const guide = MODE_GUIDE[i.mode];
  if (guide) parts.push(guide);
  else if (i.stage === "review") parts.push("Mode: review. Review this task's diff (read only), post findings with `botss review comment`, then `botss review approve` or `botss review request-changes`. Flag anything the task did not ask for as scope creep.");
  else if (i.stage === "verify") parts.push("Mode: verify. Verify this task against its acceptance criteria in the running app with your own stack, then `botss qa pass` or `botss qa fail` with a report.");
  else if (i.stage === "fix") parts.push("Mode: fix. Your task came back with review comments or QA bugs (below). Address every one, re-verify, and finish with `botss task done`.");
  else parts.push(`Mode: ${i.mode}. Build exactly what the task asks; nothing extra.`);

  if (i.task && i.task.kind !== "planning") {
    parts.push(`## Task ${i.task.id}\n\n\`\`\`markdown\n${i.task.source || `# ${i.task.title}\n\n${i.task.body}`}\n\`\`\``);
  } else if (i.task?.body) {
    parts.push(i.task.body);
  }
  if (i.handoff) parts.push(`## Handoff from the engineer\n\n${i.handoff}`);
  if (i.diffStat) parts.push(`## Diff stat (base...head)\n\n\`\`\`\n${i.diffStat}\n\`\`\``);
  for (const e of i.extra ?? []) if (e) parts.push(e);
  if (i.inbox.length) {
    const shown = i.inbox.slice(-INBOX_LIMIT);
    const more = i.inbox.length - shown.length;
    const clip = (s: string) => (s.length > INBOX_CHARS ? `${s.slice(0, INBOX_CHARS)}… (run \`botss inbox\` for the rest)` : s);
    parts.push(
      `## Unread messages${more ? ` (latest ${shown.length} of ${i.inbox.length})` : ""}\n\n${shown.map((m) => `- ${m.id} from ${m.from_agent} (${m.kind}): ${clip(String(m.body))}`).join("\n")}`,
    );
  }
  parts.push(i.task && i.task.kind !== "planning" ? "Start by running `botss task show $BOTSS_TASK`." : "Start with the files named above.");
  return parts.join("\n\n");
}

export function roleTitle(roles: RolesFile, role: string): string {
  return roles.roles[role]?.title ?? role;
}
