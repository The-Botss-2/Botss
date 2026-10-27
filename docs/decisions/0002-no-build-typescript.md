# 0002: Run TypeScript directly with Node type stripping

**Status:** accepted · 2026-10-27

**Decision.** Server, CLI, core, fake-claude, and tests are TypeScript that Node ≥ 22.18 runs directly (erasable syntax only: no enums, no parameter properties, `import type`, `.ts` import specifiers). Workspace packages export `src/index.ts`. Only the dashboard is built (Vite).

**Why.** `pnpm install && pnpm build` is the whole setup; the `botss` CLI, the guard hook, and agent shims run from source with no stale `dist/` to forget. `tsc --noEmit` still type-checks everything in CI.

**Consequences.** Node 22.18+ is required (`engines`, `botss doctor`).
