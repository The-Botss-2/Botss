# 0005: Every agent run belongs to a task

**Status:** accepted · 2026-10-27

Planning runs, answers to teammate questions, integration fixes, and release checks are all rows in `tasks` with a `kind` (`planning`, `answer`, `integrate`, `release`, `build`). One scheduler, one run lifecycle, one set of caps and quota checks covers all of them, and the dashboard can show everything on one timeline. The Kanban shows build, integrate, and release tasks; planning and answer tasks appear in a separate strip.

Resumes are data, not control flow: a task carries `meta.resume = {session, prompt}` (set by an answer, review comments, a QA fail, a usage limit, the kill switch, or a restart), and the next run of that task uses `--resume`.
