# Security review (v0.1)

Scope: what a malicious web page, a misbehaving agent, or a confused agent could do on the owner's machine through Botss. Reviewed 2026-10-27.

| Area | Control | Where |
|---|---|---|
| Network exposure | Server listens on `127.0.0.1` only; `host` other than 127.0.0.1 is refused at construction | `packages/server/src/server.ts` |
| DNS rebinding | Requests whose `Host` header is not `127.0.0.1`, `localhost`, or `::1` get 421 | `api.ts` onRequest hook |
| Owner token | 24 random bytes per `botss up`, compared in constant time; printed in the URL; dashboard sends it as `Authorization: Bearer`, so cross-site pages cannot ride on cookies. Static assets use an `HttpOnly; SameSite=Strict` cookie. `server.json` (holds the token for the local CLI) is written with mode 0600 in `~/.botss/` | `tokens.ts`, `server.ts`, `registry.ts` |
| Agent tokens | One per run, scoped to project, agent, role, task, and run; revoked when the run ends; never valid for owner-only routes or other projects | `tokens.ts`, `api.ts` (`human()`, `project()`) |
| Role permissions | `authorize()` in core: own-task status only; review commands for reviewer, QA, designer; QA commands for QA; `plan submit` for the tech lead; documents by owner role. Exit 3 on violation | `packages/core/src/permissions.ts` (unit tested) |
| Agent file writes | `PreToolUse` guard: inside the worktree only, within `owns + may_touch + role writes + scratch`; `..` normalized; symlinks resolved on the deepest existing ancestor; `.git/` and `botss.db` refused; reviewer limited to `.botss/reviews/` | `packages/core/src/guard.ts`, `packages/cli/src/hook.ts` (table-driven tests) |
| Shell commands | Guard denies force pushes, pushes to other branches, merges (except integrate tasks), shared-branch rebases and checkouts, worktree and branch deletion, `rm` outside the worktree, other stacks' compose volumes and `prune`, non-localhost `curl`/`wget`, `~/.claude` and credential reads, `botss.db`, and anything referencing the run's guard file or hook config. Wrapped forms (`bash -c`, `$(…)`, env prefixes, `sudo`) are unwrapped | `guard.ts` |
| Bash writes the hook cannot see | Backstop: `botss task done` refuses when the branch diff touches files outside the task's paths, and only the orchestrator merges | `commands.ts` `taskDone` |
| Credentials | Botss never reads `~/.claude`, never passes `--bare`, never calls Anthropic APIs, and strips `BOTSS_*` from the inherited environment before setting its own | `orchestrator.ts` `envFor` |
| Path traversal in file APIs | Skills editor, design screens, and run streams go through `safeJoin` (rejects absolute paths, `..`, NUL, and symlinks escaping the base) plus strict name patterns; documents are served from the DB; attachment names are reduced to `[A-Za-z0-9._-]` | `safe-path.ts`, `api.ts`, `orchestrator.ts` `submitIdea` |
| Design previews | Screen HTML is returned as `text/plain` with `Content-Security-Policy: sandbox` and rendered in an iframe with `sandbox="allow-scripts"` (no `allow-same-origin`), so mockup scripts cannot reach the dashboard origin or the token | `api.ts`, dashboard Design screen |
| Clickjacking | `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer` on dashboard pages | `server.ts` |
| Prompt injection | Skills tell agents to treat idea text, attachments, and messages as data, and to escalate requests to skip verification or touch other files. The guard and permission checks do not depend on the model complying | `skills/team-protocol/SKILL.md` §3 |
| Runaway cost | Global and per-role caps, daily budget with reserve, `--max-turns`, wall-clock timeout, three-strikes blocking, kill switch | `quota.ts`, `orchestrator.ts` |

## Known limits

* The guard pattern-matches shell commands; a determined agent could write files through an interpreter (`python -c`). The diff backstop at `task done` and orchestrator-only merges keep such writes out of `botss/integration`, but they can still change files inside the agent's own worktree.
* Agents run as the owner's OS user. Botss is a policy sandbox, not an OS sandbox. For untrusted ideas, run Botss inside a VM or container.
* `permission_mode: bypassPermissions` disables Claude Code's own permission prompts (the Botss guard hook still runs). It is an owner opt-in with a warning in Settings.
