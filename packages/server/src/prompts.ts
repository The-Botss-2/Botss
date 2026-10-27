import type { RolesFile } from "@botss/core";
import fs from "node:fs";
import path from "node:path";
import type { Row } from "@botss/core";
import type { TaskRow } from "./service.ts";

// Prompt assembly. system.md = Botss header + the role's SKILL.md bodies (roles.yaml order). The run prompt
// (user message) stays lean: the task file, unread messages, and pointers to files by path.

export function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

export function readSkill(skillsDir: string, name: string): string | null {
  const f = path.join(skillsDir, name, "SKILL.md");
  return fs.existsSync(f) ? stripFrontmatter(fs.readFileSync(f, "utf8")) : null;
}

export interface SystemPromptInput {
  agent: string;
  role: string;
  roleTitle: string;
  project: string;
  task: string | null;
  mode: string;
  skills: string[];
  skillsDir: string;
}

export function buildSystemPrompt(i: SystemPromptInput): string {
  const header = [
    "# Botss agent run",
    "",
    `You are **${i.agent}**, the ${i.roleTitle} on the Botss team building **${i.project}**.`,
    `Task: ${i.task ?? "(planning run, no board task)"} · Mode: \`${i.mode}\``,
    "",
    "You run headless: nobody reads this conversation. Everything the team needs goes through the `botss` CLI or into files.",
    "Your skills are below. Their `references/` and `templates/` live under `.botss/skills/<skill>/` in your working directory",
    "(for example `.botss/skills/team-protocol/references/botss-cli.md`). Open a reference only when the skill tells you to.",
    "Project conventions live in `.botss/docs/architecture.md` (Conventions section) once the architecture exists.",
    "A guard hook enforces your write paths and blocks unsafe commands; if it blocks you, do not try to get around it: ask.",
    "",
  ].join("\n");
  const bodies = i.skills
    .map((s) => {
      const body = readSkill(i.skillsDir, s);
      return body ? `\n\n---\n\n<!-- skill: ${s} -->\n${body}` : `\n\n<!-- skill ${s} not found -->`;
    })
    .join("");
  return header + bodies + "\n";
}

const MODE_GUIDE: Record<string, string> = {
  discover:
    "Mode: discover. Read the owner's idea in `.botss/docs/idea.md` (and anything in `.botss/docs/attachments/`). Write your clarifying questions as one batch to `.botss/docs/discovery/questions.json` and post it with `botss ask @human --batch .botss/docs/discovery/questions.json`. Then finish your run with a one-line summary.",
  draft:
    "Mode: draft. Write the PRD to `.botss/docs/prd.md` from `.botss/skills/product-manager/templates/prd.md`, using the idea and the owner's answers, then `botss doc submit prd` and finish.",
  revise: "Mode: revise. The owner requested changes to the PRD. Address every comment below in `.botss/docs/prd.md`, then `botss doc submit prd` and finish.",
  direction:
    "Mode: direction. Read the approved PRD (`.botss/docs/prd.md`). Propose 2 to 3 visual directions as one batch (`.botss/docs/design/directions.json`, same format as a question batch, one question whose options are the directions; include palette, type, and mood in each option label or description) and post with `botss ask @human --batch .botss/docs/design/directions.json`. Then finish.",
  system:
    "Mode: system. Build the chosen direction into `.botss/docs/contracts/design-tokens.json`, the Tailwind v4 theme, and `.botss/docs/design/DESIGN.md`. Commit. Then finish (screens come in the next run).",
  screens:
    "Mode: screens. Write one spec and one HTML mockup per screen under `.botss/docs/design/screens/` (mockups as `<screen>.html`, self-contained, no external scripts). Commit, then `botss doc submit design` and finish.",
  architect:
    "Mode: architect. Write `.botss/docs/architecture.md` and the contracts in `.botss/docs/contracts/` from the approved PRD and design. Run the architecture checks, commit, then `botss doc submit architecture` and finish.",
  plan:
    "Mode: plan. Write the task files in `.botss/tasks/` and `.botss/docs/plan-summary.md` (team recommendation, critical path, quota estimate). Run `botss plan check .botss/tasks/` until clean, commit, then `botss plan submit .botss/tasks/` and finish.",
  answer: "Mode: answer. A teammate asked you a question (below). Answer it with `botss reply <message-id> \"...\"`, update a contract or record a decision if needed (and commit), then finish.",
  integrate:
    "Mode: integrate. A merge into `botss/integration` failed. Your worktree is on a fresh branch from the integration head. Merge the task branch named below (`git merge --no-ff <branch>`), resolve to what the contract says, run the checks, commit, write your handoff, and `botss task done $BOTSS_TASK --status DONE --handoff .botss/handoffs/$BOTSS_TASK.md`.",
  ruling:
    "Mode: ruling. This task used all its review rounds. Read the review comments below and the code, decide what remains, make the minimal fixes within the task's owned paths, and finish it with `botss task done`. Record your ruling in the handoff.",
  journey: "Mode: journey. Write and run the committed Playwright journey tests for the PRD's core journeys, then `botss qa pass` or `botss qa fail` on your task.",
  release:
    "Mode: release. Run the full suite and every journey on the merged integration branch. Write the release QA report, then `botss qa pass $BOTSS_TASK --report <file>` (go) or `botss qa fail $BOTSS_TASK --report <file>` (no-go, with bugs).",
  audit:
    "Mode: audit. Audit the merged branch per your skill. File bugs with `botss bug create --task $BOTSS_TASK ...` for real findings, write `.botss/docs/security/audit.md`, commit, and finish with `botss task done $BOTSS_TASK --status DONE --handoff .botss/handoffs/$BOTSS_TASK.md`.",
};

export interface RunPromptInput {
  mode: string;
  stage: string;
  task: TaskRow | null;
  inbox: Row[];
  extra?: string[];
  handoff?: string | null;
  diffStat?: string | null;
}

export function buildRunPrompt(i: RunPromptInput): string {
  const parts: string[] = [];
  const guide = MODE_GUIDE[i.mode];
  if (guide) parts.push(guide);
  else if (i.stage === "review") parts.push("Mode: review. Review this task's diff (read only), post findings with `botss review comment`, then `botss review approve` or `botss review request-changes`.");
  else if (i.stage === "verify") parts.push("Mode: verify. Verify this task against its acceptance criteria in the running app with your own stack, then `botss qa pass` or `botss qa fail` with a report.");
  else if (i.stage === "fix") parts.push("Mode: fix. Your task came back with review comments or QA bugs (below). Address every one, re-verify, and finish with `botss task done`.");
  else parts.push(`Mode: ${i.mode}.`);

  if (i.task && i.task.kind !== "planning") {
    parts.push(`## Task ${i.task.id}\n\n\`\`\`markdown\n${i.task.source || `# ${i.task.title}\n\n${i.task.body}`}\n\`\`\``);
  } else if (i.task?.body) {
    parts.push(i.task.body);
  }
  if (i.handoff) parts.push(`## Handoff from the engineer\n\n${i.handoff}`);
  if (i.diffStat) parts.push(`## Diff stat (base...head)\n\n\`\`\`\n${i.diffStat}\n\`\`\``);
  for (const e of i.extra ?? []) if (e) parts.push(e);
  if (i.inbox.length) {
    parts.push(`## Unread messages\n\n${i.inbox.map((m) => `- ${m.id} from ${m.from_agent} (${m.kind}): ${m.body}`).join("\n")}`);
  }
  parts.push(i.task && i.task.kind !== "planning" ? "Start by running `botss whoami` and `botss task show $BOTSS_TASK`." : "Start by running `botss whoami`.");
  return parts.join("\n\n");
}

export function roleTitle(roles: RolesFile, role: string): string {
  return roles.roles[role]?.title ?? role;
}
