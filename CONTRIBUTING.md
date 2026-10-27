# Contributing to Botss

Thanks for helping. Botss is small on purpose: plain code for decisions, markdown skills for agent behavior.

## Setup

```bash
corepack enable && pnpm install && pnpm build
pnpm check        # typecheck + lint + unit and e2e tests (Vitest, fake claude)
pnpm test:e2e     # dashboard Playwright tests
```

Node 22.18+ runs the TypeScript directly; there is no build step except the dashboard.

## Ground rules

1. **No real Claude runs in tests.** Everything automated uses `packages/fake-claude` (set `BOTSS_CLAUDE_BIN` to its `src/main.ts`, and describe agent behavior in a scenario file; see `tests/helpers.ts`).
2. **Test first** for core logic, permissions, the guard, and the scheduler. `packages/core` stays pure.
3. **Deterministic over clever.** No LLM calls for scheduling, permissions, plan validation, or merging.
4. **Skills are the spec.** If code and a skill disagree, change both together and add a record in `docs/decisions/`.
5. **Erasable TypeScript only**: no enums, no parameter properties, `import type` for types, `.ts` import specifiers.
6. Small conventional commits (`feat:`, `fix:`, `docs:`, `test:`).

## Adding a role or stack

See "Contributing a new role or stack" in `skills/` conventions: create `skills/<role>/SKILL.md` (with a trigger-style description, under ~400 lines, references in `references/`), add the role to `roles.yaml`, and if it needs new permissions, update `packages/core/src/permissions.ts` with tests.

## Reporting security issues

Please open a private security advisory on GitHub rather than a public issue.
