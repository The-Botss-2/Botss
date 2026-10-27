# 0001: SQLite through Node's built-in `node:sqlite` instead of better-sqlite3

**Status:** accepted · 2026-10-27

**Context.** The original design named `better-sqlite3`. It is a native addon: users without a matching prebuilt binary (new Node majors, some Linux distros, Windows without build tools) hit `node-gyp` failures during `pnpm install`, which is the worst possible first impression for an open-source tool whose setup is guided by Claude Code.

**Decision.** Use `node:sqlite` (`DatabaseSync`), built into Node ≥ 22.13, with the same synchronous API style, WAL mode, and plain SQL migrations (`packages/core/src/db.ts`). The "experimental" warning is silenced with `--disable-warning=ExperimentalWarning` in every Botss-launched Node process.

**Consequences.** Zero native dependencies. Minimum Node is 22.18 (also needed for type stripping, see 0002). If `node:sqlite` changes its API, only `db.ts` is affected.
