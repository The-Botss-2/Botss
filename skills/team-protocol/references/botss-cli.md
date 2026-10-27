# botss CLI reference

The `botss` CLI is the only way agents read and write shared team state. It talks to the local Botss server, which stores everything in `.botss/botss.db` and streams events to the dashboard. All commands print plain text by default; add `--json` for machine-readable output.

Environment variables set by the orchestrator for every agent run:

| Variable | Meaning |
|---|---|
| `BOTSS_AGENT` | Your agent ID, for example `backend-1` |
| `BOTSS_ROLE` | Your role, for example `backend` |
| `BOTSS_TASK` | The task you were started for, for example `T012` |
| `BOTSS_ROOT` | Path to the main project checkout (read only for you) |
| `BOTSS_WORKTREE` | Your worktree path |

## Identity and orientation

```bash
botss whoami
# agent: backend-1   role: backend
# task: T012 "Orders list endpoint with pagination"
# worktree: ../.botss-worktrees/backend-1-T012   branch: botss/T012-orders-list

botss task show T012          # full task: goal, context, criteria, owned paths, deps, review notes
botss task list --ready       # tasks ready to start (useful for leads only)
botss task list --role frontend --status in_progress
botss doc list                # PRD, architecture, contracts, design, decisions with paths
```

## Working a task

```bash
botss task start T012
botss progress "Schema and migration done; writing endpoint tests"
botss task block T012 --on @tech-lead --reason "Contract has no error shape for invalid cursor"
botss task unblock T012       # usually done for you when your question is answered
botss task done T012 --status DONE --handoff .botss/handoffs/T012.md
botss task done T012 --status DONE_WITH_CONCERNS --handoff .botss/handoffs/T012.md
botss task done T012 --status NEEDS_CONTEXT --handoff .botss/handoffs/T012.md   # lists missing information
# There is no BLOCKED status for `done`: a blocked task uses `botss task block`.
```

`botss task done` fails if your owned files have uncommitted changes, so commit first. Scratch folders (`.botss/handoffs/`, `.botss/reviews/`, `.botss/screens/`) are gitignored and excluded from this check; the CLI reads the file you pass and stores its content on the board. For `DONE` and `DONE_WITH_CONCERNS` it then runs the task's `verify` command in your worktree and refuses to complete the task on a non-zero exit, printing the output. Fix the failure and run it again.

## Messaging

Addresses: a role (`@pm`, `@tech-lead`, `@designer`, `@backend`, `@frontend`, `@qa`, `@reviewer`, `@devops`, `@security`), a specific agent (`@backend-2`), everyone (`@team`, use rarely), or the owner (`@human`).

```bash
botss msg @frontend "Auth cookie name is botss_session (httpOnly, SameSite=Lax). See D-004."
botss ask @pm "Can guests check out, or is login required? PRD section 4.2 does not say."
botss ask @human "Stripe test keys are needed for T020. Add STRIPE_SECRET_KEY to .env?"
botss inbox                   # unread messages, newest last
botss inbox --all             # full thread history for your task
botss reply M-0042 "Done, merged in T012."
```

`botss ask` blocks your task until someone replies. The reply arrives in your inbox, and the orchestrator resumes you with it in your prompt. Ask one clear question per `ask`, include where you looked, and propose a default: "I suggest X because Y; OK?" Questions with a proposed default get answered faster.

For several decisions at once (the PM's discovery questions, the designer's visual directions), send one batch so the owner answers everything in a single sitting:

```bash
botss ask @human --batch .botss/docs/discovery/questions.json
```

The dashboard shows each question as a card with options and your recommendation, and an "accept all recommendations" button. The batch file format is in the product-manager skill (`references/discovery.md`).

## Decisions (lightweight ADRs)

```bash
botss decision "Cursor pagination for all list endpoints" \
  --why "Offset pagination breaks with concurrent inserts; lists are append heavy" \
  --affects backend,frontend
botss decision list
botss decision show D-007
```

Decisions are stored in `.botss/docs/decisions/` and shown on the dashboard. Record a decision when the choice constrains other agents or will surprise a future reader.

## Documents

```bash
botss doc show prd
botss doc show contracts/openapi.yaml
botss doc submit prd --file .botss/docs/prd.md      # PM / tech lead / designer: submit for human approval
botss doc submit architecture                      # --file is optional when the doc lives at its standard path
```

Document names and their standard paths (used by `doc show` and `doc submit` when `--file` is omitted):

| Name | Path | Owner |
|---|---|---|
| `prd` | `.botss/docs/prd.md` | PM |
| `architecture` | `.botss/docs/architecture.md` | Tech lead |
| `contracts/<file>` | `.botss/docs/contracts/<file>` (for example `contracts/openapi.yaml`) | Tech lead (design tokens: designer) |
| `design` | `.botss/docs/design/DESIGN.md` plus `.botss/docs/design/screens/` | Designer |
| `plan` | `.botss/docs/plan-summary.md` plus the task files in `.botss/tasks/` | Tech lead |
| `decisions/<id>` | `.botss/docs/decisions/<id>.md` | Whoever recorded it |

Documents submitted for approval appear in the dashboard's approval queue. Work that depends on an unapproved document stays `todo`.

## Planning (tech lead)

```bash
botss plan submit .botss/tasks/       # import task files into the board
botss plan check .botss/tasks/        # same validation without importing
```

Validation is deterministic and checks: required fields present, every `after` ID exists, no dependency cycles, and no ownership collisions (two tasks with no dependency path between them whose `owns` globs overlap). It prints each problem with the task IDs involved. The plan is not imported until it passes, and build tasks stay `todo` until the owner approves the plan in the dashboard.

## Review and QA (reviewer, QA, and designer roles)

The designer uses the same review commands for design review of built UI tasks; QA uses the `qa` commands.

```bash
botss review start T012
botss review comment T012 --file app/api/orders.py --line 42 --severity major "Cursor is not validated; invalid base64 raises 500"
botss review approve T012 --summary "Clean; one minor nit left as comment"
botss review request-changes T012 --summary "2 major issues, see comments" --file .botss/reviews/T012.md   # --file attaches the full review

botss qa pass T012 --report .botss/reviews/T012-qa.md
botss qa fail T012 --report .botss/reviews/T012-qa.md          # creates bug items linked to the task
botss bug create --task T012 --severity major --title "..." --file .botss/reviews/T012-bug-1.md   # severity: blocker | major | minor | trivial
```

## Exit codes

`0` success, `1` refused on its merits (for example `task done` with uncommitted owned files or a failing `verify`, or a plan with problems; read the output and fix your work), `2` invalid arguments, `3` not allowed for your role or task, `4` server unreachable. If the server is unreachable, wait a few seconds and retry once; if it still fails, finish your local work, commit, and leave the handoff note at `.botss/handoffs/<task>.md`; the orchestrator collects it when the server is back.
