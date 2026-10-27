# Claude Code integration

Botss only talks to Claude through the official `claude` CLI, started as a child process on the owner's machine with the owner's own login. Botss never reads, copies, or forwards credentials, never reads `~/.claude`, and never calls Anthropic APIs directly.

This file records exactly which CLI features Botss relies on, and how each was verified. Claude Code changes quickly: re-check this list when you upgrade, and update `packages/server/src/runner.ts` (`claudeArgs`) and `packages/core/src/stream.ts` if anything moves.

Verified against **Claude Code 2.1.310** (`claude --version`) on 2026-10-27, using `claude --help`, flag probes that exit before any model call (`claude -p <flag> </dev/null` reports "Input must be provided…" for a known flag and "unknown option" for an unknown one), and the official docs ([CLI reference](https://code.claude.com/docs/en/cli-reference.md), [headless mode](https://code.claude.com/docs/en/headless.md), [hooks](https://code.claude.com/docs/en/hooks.md), [settings](https://code.claude.com/docs/en/settings.md), [permission modes](https://code.claude.com/docs/en/permission-modes.md), [skills](https://code.claude.com/docs/en/skills.md)). No real `claude -p` run was made while building Botss; all automated tests use `packages/fake-claude`.

## The command Botss runs

```
claude -p
  --output-format stream-json --verbose
  --session-id <uuid>                 # fresh run
  | --resume <session-id>             # resume after an answer, review comments, or an interruption
  --append-system-prompt-file .botss/runs/<run>/system.md
  --settings .botss/runs/<run>/settings.json
  --permission-mode <settings.permission_mode, default dontAsk>
  --permission-prompts none
  --allowedTools <comma-separated allowlist>
  --disallowedTools <comma-separated denylist>
  --max-turns <per role>
  [--model <per role>]
```

* The prompt is written to **stdin**, not passed as an argument (no length or quoting limits; works through `claude.cmd` on Windows).
* The working directory is the agent's git worktree.
* Binary: `BOTSS_CLAUDE_BIN` (default `claude`). A path ending in `.ts`/`.js` is run with Node (this is how tests use `fake-claude`). On Windows an npm `.cmd` shim is resolved through `PATHEXT` and started through `cmd.exe` with explicit quoting.

| Feature | Status | Notes |
|---|---|---|
| `-p` + `--output-format stream-json --verbose` | verified (help + docs) | Newline-delimited JSON events, see below |
| `--append-system-prompt-file <path>` | verified (probe: "Append system prompt file not found" for a missing file) | Hidden from `--help`, documented in the CLI reference |
| `--session-id <uuid>` | verified (help) | Must be a valid UUID |
| `--resume <id>` | verified (help + docs) | Keeps the same session id unless `--fork-session` is passed |
| `--permission-mode` | verified | Choices in 2.1.310: `acceptEdits`, `auto`, `bypassPermissions`, `manual` (alias of `default`), `dontAsk`, `plan`. Since 2.1.302 a `-p` run with no mode set denies calls needing approval |
| `--permission-prompts none` | verified (help) | Anything that would prompt is denied instead of waiting for a human. Added in 2.1.259; Botss requires ≥ 2.1.259 for unattended runs |
| `--allowedTools` / `--disallowedTools` | verified | Rule syntax `Bash(git *)`; the space before `*` matters; shell operators are split and each subcommand must match |
| `--settings <file-or-json>` | verified | Used only to inject the per-run `PreToolUse` hook; never touches the user's settings files. Hooks merge with user/project hooks |
| `--max-turns N` | verified (probe) | Hidden from `--help`; result subtype `error_max_turns` when hit |
| `--model` | verified (help) | Alias (`opus`, `sonnet`, `haiku`, `fable`) or full name |

## Stream events Botss parses (`packages/core/src/stream.ts`)

| Event | Shape relied on | Becomes |
|---|---|---|
| `{"type":"system","subtype":"init"}` | `session_id`, `model`, `tools` | `run.init` event; session id stored on the run |
| `{"type":"assistant"}` | `message.content[]` blocks: `tool_use` (`id`, `name`, `input`) and `text` | `run.tool` with a human summary ("Editing \`backend/app/api/orders.py\`", "Running \`pytest -q\`"); `run.text` (first ~200 chars, only if meaningful); the agent card's live action and file |
| `{"type":"user"}` | `message.content[]` `tool_result` with `is_error` | Guard blocks surface as `run.blocked` |
| `{"type":"system","subtype":"api_retry"}` | `error`, `attempt`, `retry_delay_ms` | `run.retry` |
| `{"type":"rate_limit_event"}` | `rate_limit_info.status`, `resetsAt` (epoch seconds) | Only `status: "rejected"` is treated as a limit. The field set is **not documented**; parsing is tolerant |
| `{"type":"result"}` | `subtype` (`success`, `error_max_turns`, `error_during_execution`, …), `is_error`, `num_turns`, `total_cost_usd`, `usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`, `session_id`, `result` or `errors[]` | Turns, tokens, and cost on the `runs` row; usage-limit detection |

The full raw stream of every run is kept in `.botss/runs/<run>/stream.jsonl` (gitignored) and is viewable on the Agents screen.

**Usage limits.** The exact print-mode text of a subscription limit is not documented. Botss treats an error result whose text matches `usage limit|session limit|weekly limit|hit your … limit|rate limit|Claude AI usage limit reached` as a limit, and reads a reset time from `…|<epoch>` or "resets 3:45pm" when present (default: one hour). It then pauses scheduling (`state.limitedUntil`), alerts the owner, and resumes automatically after the reset unless `auto_resume_after_limit` is off. Interrupted tasks are resumed on the same session.

**Quota.** There is no supported non-interactive command that reports subscription quota (`claude auth status` reports auth only). Botss therefore tracks its own usage from `result` events and enforces the owner's daily budget and reserve itself.

## Hooks

Per-run `settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob",
        "hooks": [{ "type": "command", "command": "\"<node>\" --disable-warning=ExperimentalWarning \"<botss>/packages/cli/src/main.ts\" hook pre-tool-use", "timeout": 30 }]
      }
    ]
  }
}
```

* Stdin JSON fields used: `tool_name`, `tool_input`, `cwd` (also present: `session_id`, `transcript_path`, `hook_event_name`, `tool_use_id`, `permission_mode`).
* Blocking: exit code **2**; stderr becomes the reason the agent sees. (JSON `hookSpecificOutput.permissionDecision: "deny"` also exists; Botss uses the exit code.)
* The hook reads its run context from `BOTSS_GUARD_FILE` (inherited from the `claude` process environment), so it needs no server round trip on the allow path. Blocks are reported to the server best effort for the live feed.
* On Windows, Claude Code runs command hooks through Git Bash (PowerShell only if Git Bash is absent); Botss writes paths with forward slashes so the command works in both bash and cmd.
* Botss never passes anything that disables hooks (`--bare` and `disableAllHooks` are never used).

## Skills placement

Project `.claude/skills/` are auto-discovered from the working directory up to the repo root. That would offer every role every skill, so Botss keeps skills in `.botss/skills/` (not discovered) and injects the role's SKILL.md bodies, in `roles.yaml` order, through `--append-system-prompt-file`. References and templates stay on disk under `.botss/skills/<skill>/` and are opened by the agent on demand. See `docs/decisions/0003-skill-placement.md`.

## Things Botss deliberately does not use

* `--bare`: it never reads OAuth credentials, so subscription logins would not work.
* `bypassPermissions` / `--dangerously-skip-permissions`: owner opt-in only, with a warning in Settings.
* `--max-budget-usd`: API-billing oriented; Botss budgets in tokens.
* The Agent SDK: not used with subscription auth.
