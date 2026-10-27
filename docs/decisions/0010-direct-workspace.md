# 0010: Direct workspace mode is the default

**Status:** accepted · 2026-10-27 · supersedes the default in 0004

**Context.** Owners expect Botss to behave like Claude Code: agents change the files in the folder they chose. The original design gave each task its own git worktree and branch and merged them into `botss/integration`. That kept parallel agents apart, but it put the work somewhere else (`../.botss-worktrees/...`), wrote skills, docs, and branches into the owner's repository before anything happened, and required git.

**Decision.** `settings.workspace` is `direct` by default:
* Every run's working directory is the project folder. Botss adds one hidden `.botss/` folder (database, docs, tasks, handoffs, reviews, snapshots, runs) and no git repository, branches, or commits. If the folder already uses git, `.botss/` is added to `.git/info/exclude` and agents may only read git state.
* Parallel safety comes from file ownership: plan validation forbids overlapping `owns` between tasks with no dependency path, the scheduler never runs two tasks whose `owns` overlap and treats tasks in review/QA/changes as still holding their files, and the guard hook denies writes outside a task's paths and any git command that changes state.
* "What changed" comes from a snapshot of a task's owned files taken at its first run (`.botss/snapshots/<task>/`), diffed against the folder for the reviewer's prompt and the dashboard.
* When QA passes, the task is done (no merge). The project's checks then run; a failure creates a tech-lead `repair` task.
* Skills are read from the Botss installation; the skills editor copies them into `.botss/skills/` on the first edit.

**Isolated mode** (`workspace: isolated`, the previous design) remains available and is what the git-based end-to-end tests exercise. Projects created before this change that had not started building are moved to direct mode on open; the rest stay isolated.

**Shell access.** The default tool permissions now allow `Bash` generally (with `--permission-mode dontAsk`) instead of a prefix allowlist that silently denied ordinary commands. The guard hook is the safety boundary.
