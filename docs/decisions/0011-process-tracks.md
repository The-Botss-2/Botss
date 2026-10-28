# 0011: Process tracks sized by triage

**Status:** accepted · 2026-10-28

**Context.** A one-line UI change went through discovery questions, a PRD, design directions, screen mockups, architecture, and a plan before any code was written. Real teams size work first.

**Decision.** Every request starts with a short tech-lead `triage` run (unless the owner picks the full track), which writes `.botss/docs/triage.md` with `track: quick | standard | full` and a few sentences for the owner:
* **quick**: the triage run also writes 1 to 3 task files and submits them. The plan is auto-approved, tasks are marked `fast` (verify must pass; no review or QA round), and when they finish the release summary is auto-approved and the project goes to `done`. If no tasks were planned, the track falls back to standard.
* **standard**: a PM `draft` run writes a short PRD straight from the request (no discovery batch); after the PRD gate, the tech lead plans directly (no design directions, screens, or architecture document); the build uses review and QA as usual.
* **full**: the original flow (with the codebase survey first for existing projects).

The owner can choose the track (auto, quick, standard, full) on the Idea screen. A new request is accepted when the project is in `idea` or `done`, so finished projects take the next request like a conversation. `POST /cancel` stops the agents, closes unfinished tasks and open questions, cancels an active change request, and returns to `idea`; finished work stays.

Sizing a free-text request needs judgment, so it is an agent run; everything after the decision (which runs, gates, and stages happen) is plain code.
