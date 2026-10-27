# 0006: Integration check commands come from a `## Checks` section

**Status:** accepted · 2026-10-27

The merge pipeline runs the project's check commands on `botss/integration` after every merge. They are taken deterministically from the T000 and T001 handoffs: the lines under a `## Checks` heading (one command per line, optionally in backticks or a list). If T000 has none, its `verify` command is used. The owner can edit them in Settings.

The tech-lead skill already asks the T000 handoff to list "the exact commands every other agent will use"; the handoff template now names the `## Checks` heading so plain code can read it.
