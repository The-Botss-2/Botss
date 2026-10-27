# Planning checks

Run the architecture checks before submitting the architecture, and the plan checks before `botss plan submit`. Fix failures first. These are mechanical on purpose: they catch the problems that most often break parallel builds.

## A. Architecture checks

### Coverage
- [ ] Every FR in the PRD appears in the Requirements map with its endpoints, screens, and tables.
- [ ] Every endpoint in `openapi.yaml` traces back to at least one FR (no orphan endpoints).
- [ ] Every entity in the PRD glossary is in the data model, using the same name.

### Divergence points closed
- [ ] Error shape, pagination, IDs, timestamps, money, auth mechanism, and naming are all decided in Conventions.
- [ ] Every enum both sides use (statuses, roles) is defined once in shared types.
- [ ] Every request and response body has a named schema with field constraints; no `object` or `any` placeholders.
- [ ] Auth requirements are stated per endpoint (public, authenticated, role).
- [ ] State transitions for stateful entities (who can move an Order from Pending to Cancelled) are written.

### Rules are enforceable
- [ ] Each AD rule can be checked by reading code or running a test. "Code should be clean" is not a rule.
- [ ] Each AD has Binds, Prevents, and Rule.

### Envelope
- [ ] Local run command, environments, required env vars, migration process, and secret handling are written.
- [ ] Versions of the main frameworks are pinned.

### Lint
- [ ] No placeholders, TODOs, or "TBD" left. No duplicate AD numbers.
- [ ] The doc contains no product decisions the PRD did not make. If you had to make one, it is flagged for the PM.

## B. Plan checks

### Coverage
- [ ] Every FR is covered by at least one task (`covers` field), and every task covers at least one FR, or is T000, T001, a stub, or a QA or polish task.
- [ ] Every acceptance criterion in the PRD maps to a task's acceptance criteria or a QA task.

### Dependencies
- [ ] Everything a task needs to start (a table, an endpoint, a component, a config file) is created by that task or by a task in its `after` chain.
- [ ] No cycles.
- [ ] `after` lists only real prerequisites. Unneeded edges make the critical path longer and leave agents idle.

### Collisions
- [ ] For every pair of tasks with no dependency path between them, their `owns` globs do not overlap.
- [ ] Shared files (lockfiles, settings, router registry, root layout, shared types, migrations folder ordering) have exactly one owner, and every task that touches them is ordered after it.
- [ ] Migrations: Alembic has one revision chain for the whole project, so every migration-creating task is chained with `after` on the previous one. No two migration-creating tasks can ever be in flight together, even for different tables.
- [ ] Interfaces two parallel lanes share are produced by an earlier stub task.

### Readiness (each task)
- [ ] **Actionable:** has owned paths, a goal, and context links.
- [ ] **Bounded:** fits one agent run, roughly 1 to 6 files or one screen or endpoint group.
- [ ] **Testable:** acceptance criteria in Given / When / Then, including at least one failure path.
- [ ] **Verifiable:** a `verify` command that passes only when the task is done.
- [ ] **Complete:** Consumes and Produces filled with exact signatures; relevant contract constraints quoted.
- [ ] **Coherent:** nothing in the task contradicts the contracts or the PRD.
- [ ] Under about 1,600 tokens. Longer tasks are too big or carry too much prose.

### Shape
- [ ] New projects: T000 (app scaffold, tech lead) and T001 (infra scaffold, devops, `after: [T000]`) exist, and nothing runs in parallel with T000. Existing codebases: no scaffold tasks unless something they would create is missing.
- [ ] Every task traces to an approved FR (or is a scaffold, stub, QA, or polish task). Nothing the owner did not ask for.
- [ ] Every task has exactly one `role`.
- [ ] Every `verify` command works without `make` and uses `TEST_DATABASE_URL` for backend tests.
- [ ] A tracer bullet task for the P1 core journey comes before breadth.
- [ ] P1 tasks can all complete without any P2 task.
- [ ] Peak parallel lanes match the recommended team size.
