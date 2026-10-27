# 0008: Change requests, a design gate, and existing codebases

**Status:** accepted · 2026-10-27

**Change requests.** After the PRD has been approved once, the owner can request a change at any time (`POST /changes`, the "Request a change" button). One change is active at a time and moves through `pm → prd_review → replan → plan_review → applied` (or `cancelled`):
* A PM `change` run updates the PRD for exactly that request (with a changelog entry) and resubmits it. The PRD gate opens regardless of the project phase.
* After approval, a tech-lead `replan` run adds new task files (new IDs) and edits only `todo` tasks; started and finished task files must be unchanged, which `importPlan` enforces. New tasks are imported with `hold = "plan"`, so nothing new starts until the owner approves the updated plan. If no plan exists yet, the change is applied once the PRD is approved.
* A change approved after the release review reopens the build; the next release round gets fresh release tasks (`REL-QA-2`, ...).

**Planning work after the build starts** (change runs, answers) runs in its own worktree and is merged through the normal merge pipeline, instead of committing in the shared integration worktree while merges run.

**Design gate.** A new `design` gate (on by default) sits between the screen mockups and the architecture. Direction previews (`.botss/docs/design/directions/<key>.html`) are shown next to the options before the owner picks.

**Existing codebases.** `botss init` detects existing files (and commits them as the first commit if the folder was not a repository). The `existing` setting makes the first planning run a tech-lead `survey` that writes `.botss/docs/codebase.md`, including a `## Checks` section that becomes the integration checks. No scaffold tasks are planned.
