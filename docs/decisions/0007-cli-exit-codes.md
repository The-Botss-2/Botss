# 0007: Exit code 1 for refusals

**Status:** accepted · 2026-10-27

`botss-cli.md` defines 0 (ok), 2 (invalid arguments), 3 (not allowed), 4 (server unreachable). Botss adds **1** for a well-formed, permitted command that was refused on its merits: `task done` with uncommitted owned files or a failing `verify`, and `plan check`/`plan submit` with problems. This keeps 2 meaning "you called it wrong" and lets agents tell "fix your work" apart from "fix your command".
