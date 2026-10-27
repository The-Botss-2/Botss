# Botss: instructions for Claude Code

This repository is **Botss**, a local-first AI software team that runs on the user's own Claude Code subscription. When a user opens this folder in Claude Code and says something like "set up Botss", "install this", or "get me started", guide them through the setup below.

## Setup flow

Explain each step in one or two sentences before you run it. **Ask before installing anything system-wide** (global npm packages, Docker, uv, Node versions, shell profile edits). Never read or touch `~/.claude` or any credentials. Do not start real Botss agent runs for the user; `botss up` and the dashboard are where they start a project.

1. **Check prerequisites.** Run `node --version` (needs 22.18+) and `git --version`. If Node is fine, run `node --disable-warning=ExperimentalWarning packages/cli/src/main.ts doctor`. That doesn't need dependencies yet, but it may fail to import before `pnpm install`; if it does, do step 2 first and run `doctor` afterwards. For anything missing, explain what it is for and offer the fix; install only with the user's OK:
   * pnpm: `corepack enable` (ships with Node; may need admin rights, so ask first). Without it, use `corepack pnpm …` everywhere.
   * Docker with Compose and `uv` are needed by the apps Botss builds (per-agent databases, Python backend), not by Botss itself. They can be installed later.
   * Claude Code must be installed and logged in (`claude` once, interactively, by the user). `botss doctor --login` checks the login with one tiny prompt and asks first.
2. **Install and build:** `pnpm install && pnpm build` (or `corepack pnpm install && corepack pnpm build`). This installs dependencies and builds the dashboard. Nothing else needs compiling, because Node runs the TypeScript directly.
3. **Make `botss` work from any folder.** Explain, then ask before running `node packages/cli/bin/botss.js setup`: on Windows it writes `%USERPROFILE%\.botss\bin\botss.cmd` and adds that folder to the *user* PATH; on macOS/Linux it writes `~/.local/bin/botss` (and says if that folder is not on PATH). They need a new terminal afterwards. If they decline, they can run `node <repo>/packages/cli/bin/botss.js <command>` instead. Do not use `npm link`: the workspace's `workspace:*` dependencies are pnpm-only.
4. **Pick the project folder:** ask where the app should live (a new folder, or an existing project they want to change). Then, in a new terminal, `cd` there and run `botss up`. It opens the dashboard for that folder; if it is not a Botss project yet, the dashboard's folder picker opens there and sets it up (or run `botss init` first). The user's current branch is never modified; Botss works on `botss/integration` with worktrees in `../.botss-worktrees/`.
5. Tell the user to keep that terminal open (Ctrl+C stops Botss and every agent), then describe their idea (or, for an existing project, the change they want) on the Idea screen.

Then point them at: the approval gates (they approve the PRD, design direction, the screen designs, architecture, plan, and release), **Request a change** in the header for changing their mind mid-build, the Agents screen to watch agents work live, the team builder (start small: one backend, one frontend), the Usage screen and daily budget in Settings, and the red kill switch in the header. Remind them of the README's "Usage and terms" section: Botss uses their own Claude usage, and they are responsible for following Anthropic's terms.

## Working on Botss itself

* Monorepo: `packages/core` (pure logic, heavily unit tested), `packages/server` (Fastify API, orchestrator, runner), `packages/cli` (`botss`), `packages/dashboard` (React), `packages/fake-claude` (test double). Docs in `docs/`, decisions in `docs/decisions/`.
* `pnpm check` runs typecheck, lint, and Vitest. `pnpm test:e2e` runs the dashboard's Playwright tests.
* **Never run real `claude` agent runs while developing or testing.** Tests use `packages/fake-claude` through `BOTSS_CLAUDE_BIN` and scenario files.
* TypeScript must stay erasable (no enums, no parameter properties, `import type`, `.ts` import paths) because Node runs it directly.
* The skills in `skills/` are the spec for agent behavior and `skills/team-protocol/references/botss-cli.md` is the CLI spec. Change code and skill together, and record the decision in `docs/decisions/`.
* Plain code decides scheduling, permissions, plan validation, and merging. Do not add LLM calls for those.
