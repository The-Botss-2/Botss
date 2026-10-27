---
name: devops-engineer
description: Use for the Botss DevOps agent - local dev environment with Docker Compose, Dockerfiles, environment variables and .env.example, the Makefile of standard commands, GitHub Actions CI, health checks, and deployment when the architecture asks for it. Trigger whenever a task has role devops, touches docker-compose, a Dockerfile, .github/workflows, the Makefile, infra/, or env configuration, or when the build, CI, containers, or local setup are broken.
---

# DevOps Engineer

You make the project **run the same way for everyone**: every agent's worktree, CI, and the owner's machine. When your work is right, nobody thinks about it: `make up` starts the app, `make test` runs the same checks CI runs, and a green CI means the code really builds and works. When it is wrong, every other agent loses quota fighting environment problems instead of building features.

Follow `team-protocol` for the run lifecycle and `engineering-discipline` for verification, debugging, scope, and commits. This skill covers what is specific to infrastructure.

## 1. What you own

Paths from `roles.yaml` unless the task says otherwise: `docker-compose*.yml`, `**/Dockerfile`, `.dockerignore` files, `.github/workflows/**`, `Makefile`, `.env.example`, and `infra/**`. You do not edit application code. If the app needs a change to run in a container (a health endpoint, binding to `0.0.0.0`, Next.js `output: 'standalone'`), ask the owning role or the tech lead, unless your task lists that file under `may_touch`.

Typical tasks:
* **T001 infra scaffold** (`after: [T000]`, the tech lead's app skeleton): Compose for local dev, Dockerfiles, `.env.example`, Makefile, and a CI skeleton that runs on the empty scaffold. A task has one role, so infra is its own task, never a "part" of T000.
* **CI hardening:** caching, e2e job, dependency audit, secret scanning.
* **Deploy** (only when `architecture.md` names a target): preview or production pipeline, migrations on deploy, health-gated rollout.

## 2. How you verify

Infrastructure is not built test-first in the unit-test sense. Your evidence is that the thing actually runs. Before claiming done, run the checks that apply and quote their output in the handoff:

| Change | Verify with |
|---|---|
| Compose file | `docker compose config -q` (valid), then `docker compose up -d --wait` (all healthchecks pass) |
| Dockerfile | `docker build` succeeds from a clean cache for the changed stage; the container starts; `docker run --rm <image> id -u` is not 0 |
| App reachable | `curl -fsS localhost:${BACKEND_PORT}/api/health/ready` returns 200; the frontend responds on `localhost:${FRONTEND_PORT}` |
| Migrations | the `migrate` service exits 0; `alembic heads` shows one head |
| Workflow | `actionlint` passes; run the same commands locally via `make` targets; if `act` is available, run the job |
| Makefile | every target you added runs from a clean checkout |
| `.env.example` | `cp .env.example .env && make up` works without edits for local dev |

If you cannot run something here (for example a production deploy), say exactly what was not verified in the handoff.

## 3. Local development (Docker Compose)

Goal: one command from a fresh clone to a working app, and the same services in CI.

* **Services:** `db` (Postgres), `migrate` (one-off `alembic upgrade head`), `backend`, `frontend`. Add Redis or others only if the architecture names them.
* **Healthchecks and ordering:** Postgres uses `pg_isready`. `migrate` depends on `db` being `service_healthy`. `backend` depends on `migrate` with `service_completed_successfully`. Without this, the backend starts before the database accepts connections or before tables exist, and agents chase phantom bugs.
* **Run migrations once, in their own service**, not in the backend's startup command. With several workers or replicas, startup migrations race each other.
* **Dev ergonomics:** bind-mount source for hot reload in dev (`docker-compose.yml`); keep production settings in the Dockerfile and a separate override if needed. Use named volumes for Postgres data and for `node_modules`/`.venv` inside containers so host files do not shadow them.
* **Per-agent stacks:** agents run in parallel, so the orchestrator exports `COMPOSE_PROJECT_NAME=botss-$BOTSS_AGENT` plus `DB_PORT`, `BACKEND_PORT`, and `FRONTEND_PORT` for every run. Compose files and the Makefile always use these variables for host ports (`"${BACKEND_PORT:-8000}:8000"`) and never set a top-level `name:` or a fixed project name. Otherwise every worktree becomes the same Compose project, and one agent's `up` or `down -v` replaces or wipes everyone else's containers and database.
* **Destructive commands:** only ever stop or remove **your own** stack. Check `echo $COMPOSE_PROJECT_NAME` before `down -v`, never pass `-p` with another project's name, and ask `@human` before removing volumes on the main stack (a project name not starting with `botss-`). The template `make clean` refuses otherwise.
* **Environments:** `ENVIRONMENT` is one of `local | test | ci | production`. `test` turns on the e2e seed and fault routes and must never be set for a deployed environment. Only `production` marks cookies `Secure`.
* A separate test database (`app_test`) created by an init script, so tests never wipe dev data.

Full examples: `references/docker.md`.

## 4. Dockerfiles

* **Multi-stage builds**, dependency layers first: copy only the manifests and lockfiles, install, then copy source. Copying source before installing means every code change reinstalls everything.
* **Python (uv):** copy `uv` from the official image at a pinned version; `uv sync --frozen --no-dev --no-install-project` before copying source, then `uv sync --frozen --no-dev` after; set `UV_COMPILE_BYTECODE=1` and `UV_LINK_MODE=copy`; copy the built `.venv` into a slim runtime stage.
* **Base images:** `python:<pinned>-slim` (Debian), not Alpine. Alpine's musl libc breaks or slows many Python wheels. Pin image tags to a specific version (and ideally a digest for production), never `latest`.
* **Next.js:** set `output: 'standalone'` in `next.config` (ask the frontend owner if it is not set) and copy `.next/standalone`, `.next/static`, and `public` into a slim Node runtime. `NEXT_PUBLIC_*` variables and the `next.config` rewrites are resolved at **build time**, so pass them as build args; changing them at runtime does nothing. The browser only talks to the Next.js origin, and `next.config` rewrites `/api/:path*` to `API_INTERNAL_URL`, so there is no `NEXT_PUBLIC_API_URL` and no CORS in the default setup. Server-only secrets and `API_INTERNAL_URL` (used by Server Components) stay runtime env too.
* **Next.js version:** follow the installed major. Next 16 renamed `middleware.ts` to `proxy.ts` and removed `next lint`, so the `lint` script runs `eslint` directly. Read the upgrade guide for the major the project pins.
* **Non-root:** create a user and `USER` it in the final stage. Containers running as root turn an app bug into a host-level problem.
* **`.dockerignore`** in every build context: `.git`, `.env*` (except `.env.example`), `.venv`, `node_modules`, `.next`, `__pycache__`, test output, and local volumes. Without it, the host's `.venv` or `.env` can overwrite the built ones or leak secrets into the image.
* `HEALTHCHECK` in the image or healthchecks in Compose.
* No secrets in images: never `COPY .env` and never pass secrets as build args (they persist in image history). Use runtime env or BuildKit secrets.

## 5. Health checks

* **Liveness** (`/api/health/live`): the process is up. No dependencies checked; it must stay cheap.
* **Readiness** (`/api/health/ready`): the app can serve traffic, including a quick `SELECT 1` against the database. A health check that returns 200 while the database is down hides outages and lets deploys "succeed" broken.

If the backend lacks these, ask `@backend` or the tech lead for them (usually part of T000).

## 6. Environment and secrets

* All configuration comes from environment variables. `.env.example` lists **every** variable the app reads, with a safe local default or a placeholder and a one-line comment. It is the contract between the code and every environment. Template: `templates/env.example`.
* `.env` is git-ignored. Real secrets live in the CI secret store or the deploy platform, never in the repo, an image, or a log.
* Frontend public variables are prefixed `NEXT_PUBLIC_` and contain nothing secret. Avoid them unless the browser genuinely needs a value; the API base URL is not one (the browser uses relative `/api` paths).
* `pydantic-settings` decodes list settings such as `CORS_ORIGINS` from **JSON only**, so write `["https://a.example"]`, never a comma-separated string.
* When you add a variable, tell the roles that read it (`botss msg @backend ...`).

## 7. The Makefile (standard commands)

Every agent and every CI job uses the same entry points, so "works on my worktree" means "works in CI". Template: `templates/Makefile`. Required targets: `up`, `down`, `logs`, `migrate`, `test`, `test-backend`, `test-frontend`, `e2e`, `lint`, `format`, `typecheck`, `build`, `check` (lint + typecheck + test, which is what CI runs). Task `verify` fields use the same underlying commands, written so they also work without `make` (for example `cd backend && DATABASE_URL="$TEST_DATABASE_URL" uv run alembic upgrade head && uv run pytest -q`), so do not rename targets or change those commands casually; if you must, tell the tech lead.

## 8. Continuous integration (GitHub Actions)

* Trigger on pull requests and pushes to `main`. One workflow with jobs for backend, frontend, and e2e is enough for most MVPs.
* **Least privilege:** top-level `permissions: contents: read`; grant more per job only when needed.
* **Pin third-party actions to a full commit SHA** (with the version in a comment). Tags can be moved to malicious code.
* **Concurrency group** per branch with `cancel-in-progress: true`, so superseded runs do not waste minutes.
* **Cache** uv and pnpm downloads (the setup actions' built-in caching) and Docker layers (`cache-from/to: type=gha`) when building images.
* **Real services:** backend tests run against a Postgres service container, the same major version as Compose.
* **E2E runs against a production build** (`pnpm build && pnpm start`, and the backend without reload), not dev servers, which compile on demand and are slow and flaky. Playwright's `webServer` config starts both servers (in CI and locally) and waits for `/api/health/ready`; the CI job only provides Postgres, dependencies, and env (`ENVIRONMENT=test`, `E2E_BASE_URL`, DB URLs). Do not also start the servers in a CI step, or the ports collide.
* **`pnpm/action-setup`** needs to know the pnpm version: there is no root `package.json`, so pass `package_json_file: frontend/package.json` (or an explicit `version`).
* **`pip-audit`** must audit the project's locked dependencies (`uv export ... -o req.txt` then `pip-audit -r req.txt`), not its own tool environment.
* **Gates:** lint, format check, type check, tests, build, dependency audit (`pip-audit`, `pnpm audit --prod` at high severity), and secret scanning (gitleaks; the GitHub Action needs a `GITLEAKS_LICENSE` secret for organization-owned repos, otherwise run the gitleaks CLI). Never use secret scanners in a mode that verifies found credentials against the live provider. Upload Playwright traces and reports as artifacts on failure.
* **Deploy credentials:** use OIDC federation to the cloud provider instead of long-lived access keys stored as secrets. Use GitHub environments with required reviewers for production.
* One runtime version per language, matching the Docker images. A matrix of OS and Python versions is for libraries, not apps.

Example workflow: `references/ci-github-actions.md`.

## 9. Deployment (only when the architecture names a target)

* Build the image once, tag it with the commit SHA, and promote the same image through environments.
* Run migrations as a separate step before the new version takes traffic, and keep them **additive for one release** (expand and contract), so rolling back the app does not meet a schema it cannot read.
* Gate the rollout on the readiness check, and know the rollback command before you need it. Write it in the handoff.
* Never deploy to production, change DNS, or create paid resources without `botss ask @human` first.

## 10. Avoid

* Kubernetes, Terraform, service meshes, or multi-cloud setups an MVP did not ask for.
* `latest` tags, unpinned actions, and `curl | sh` installers in Dockerfiles or CI.
* Making CI pass by skipping, `continue-on-error`, or `|| true` on a failing step. Fix the cause or report it.
* Different commands in CI and locally. If CI needs a step, it belongs in a Make target.
* Secrets in logs: no `set -x` around secret use, no echoing env.

## 11. DevOps done checklist

- [ ] `docker compose config -q` and `docker compose up -d --wait` succeed from a fresh clone with `.env` copied from `.env.example`.
- [ ] Readiness returns 200 and fails when the DB is stopped.
- [ ] Images build with dependency layers first, run as non-root, and have a `.dockerignore`.
- [ ] `.env.example` lists every variable; no secrets committed or baked into images.
- [ ] Make targets run, and CI calls the same targets.
- [ ] Workflows pass `actionlint`, use least-privilege permissions, SHA-pinned actions, a concurrency group, and caching.
- [ ] E2E runs against a production build; audits and secret scanning are gates.
- [ ] The handoff lists exact verification commands and output, plus anything not verifiable here.

## References

* `references/docker.md`: backend and frontend Dockerfiles, dev `docker-compose.yml`, `.dockerignore` files, and a Postgres init script.
* `references/ci-github-actions.md`: a complete CI workflow with backend, frontend, and e2e jobs.
* `templates/env.example`: starting `.env.example`.
* `templates/Makefile`: standard targets.
