# Botss: instructions for Claude Code

This repository is **Botss**, a local-first AI software team that runs on the user's own Claude Code subscription. When a user opens this folder in Claude Code and says something like "set up Botss", "install this", or "get me started", guide them through the setup below.

## Setup flow

Explain each step in one or two sentences before you run it. **Ask before installing anything system-wide** (global npm packages, Docker, uv, Node versions, `npm link`). Never read or touch `~/.claude` or any credentials. Do not start real Botss agent runs for the user; `botss up` and the dashboard are where they start a project.

1. **Check prerequisites.** Run `node --version` (needs 22.18+) and `git --version`. If Node is fine, run `node --disable-warning=ExperimentalWarning packages/cli/src/main.ts doctor`. That doesn't need dependencies yet, but it may fail to import before `pnpm install`; if it does, do step 2 first and run `doctor` afterwards. For anything missing, explain what it is for and offer the fix; install only with the user's OK:
   * pnpm: `corepack enable` (ships with Node; may need admin rights, so ask first). Without it, use `corepack pnpm …` everywhere.
   * Docker with Compose and `uv` are needed by the apps Botss builds (per-agent databases, Python backend), not by Botss itself. They can be installed later.
   * Claude Code must be installed and logged in (`claude` once, interactively, by the user). `botss doctor --login` checks the login with one tiny prompt and asks first.
2. **Install and build:** `pnpm install && pnpm build` (or `corepack pnpm install && corepack pnpm build`). This installs dependencies and builds the dashboard. Nothing else needs compiling, because Node runs the TypeScript directly.
3. **Make `botss` available.** Offer the options and let the user choose:
   * `npm link ./packages/cli` (global symlink; ask first), or
   * a shell alias: `alias botss="node --disable-warning=ExperimentalWarning <repo>/packages/cli/src/main.ts"` (add it to their shell profile only if they agree), or
   * just run `pnpm botss <command>` from this folder.
4. **Initialize their project:** ask which folder the app should live in (new or existing), then `botss init <folder>`. This creates `.botss/`, copies the skills, and creates the `botss/integration` branch and its worktree next to the folder (`../.botss-worktrees/`). The user's current branch is never modified.
5. **Start Botss:** `cd <folder> && botss up`. It prints and opens `http://127.0.0.1:4800/?token=…`. Tell the user to keep that terminal open (Ctrl+C stops Botss and every agent), then describe their idea on the Idea screen.

Then point them at: the approval gates (they approve the PRD, design direction, architecture, plan, and release), the team builder (start small: one backend, one frontend), the Usage screen and daily budget in Settings, and the red kill switch in the header. Remind them of the README's "Usage and terms" section: Botss uses their own Claude usage, and they are responsible for following Anthropic's terms.

## Working on Botss itself

* Monorepo: `packages/core` (pure logic, heavily unit tested), `packages/server` (Fastify API, orchestrator, runner), `packages/cli` (`botss`), `packages/dashboard` (React), `packages/fake-claude` (test double). Docs in `docs/`, decisions in `docs/decisions/`.
* `pnpm check` runs typecheck, lint, and Vitest. `pnpm test:e2e` runs the dashboard's Playwright tests.
* **Never run real `claude` agent runs while developing or testing.** Tests use `packages/fake-claude` through `BOTSS_CLAUDE_BIN` and scenario files.
* TypeScript must stay erasable (no enums, no parameter properties, `import type`, `.ts` import paths) because Node runs it directly.
* The skills in `skills/` are the spec for agent behavior and `skills/team-protocol/references/botss-cli.md` is the CLI spec. Change code and skill together, and record the decision in `docs/decisions/`.
* Plain code decides scheduling, permissions, plan validation, and merging. Do not add LLM calls for those.
