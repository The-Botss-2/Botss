# Docker reference

Examples for the default stack. Every version tag below is a placeholder: **pin to current** stable versions when you write the real files, and keep Compose, CI, and Dockerfiles on the same major versions.

Dockerfile syntax notes: `# syntax=...` must be the very first line, and `#` starts a comment only at the beginning of a line. A trailing `# comment` after `FROM` or `COPY` is parsed as extra arguments and breaks the build, so comments always go on their own line.

## Contents
1. Backend Dockerfile (FastAPI + uv)
2. Frontend Dockerfile (Next.js standalone)
3. docker-compose.yml for local development
4. Postgres init script (test database)
5. .dockerignore files
6. Troubleshooting

## 1. Backend Dockerfile (FastAPI + uv)

```dockerfile
# syntax=docker/dockerfile:1
# backend/Dockerfile

# pin python and uv to current versions
FROM python:3.12-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app

# 1) dependencies only: cached until the lockfile changes
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# 2) the project itself
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# same base image as the builder
FROM python:3.12-slim AS runtime
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app
COPY --from=builder --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health/live').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

For local development, Compose overrides the command with `--reload` and bind-mounts the source; the image itself stays production-shaped.

## 2. Frontend Dockerfile (Next.js standalone)

Requires `output: "standalone"` in `next.config.ts`.

```dockerfile
# syntax=docker/dockerfile:1
# frontend/Dockerfile

# pin to the current Node LTS
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next.config rewrites (/api/:path* -> backend) are resolved at build time,
# so the backend address the rewrite targets is a build arg.
# Any NEXT_PUBLIC_* values are also inlined at build time and must be build args.
ARG API_INTERNAL_URL=http://backend:8000
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# same base image as above
FROM node:22-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app app
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
```

The browser only ever talks to the Next.js origin. `next.config.ts` rewrites `/api/:path*` to `${API_INTERNAL_URL}/api/:path*`, so the session cookie is same-origin and no CORS is needed. Server Components call `API_INTERNAL_URL` directly and forward the cookie, so `API_INTERNAL_URL` is also set as runtime env. Because rewrites are baked in at build time, an image built for one backend address must be rebuilt (or use a route-handler proxy) to point elsewhere.

## 3. docker-compose.yml for local development

```yaml
# docker-compose.yml
# No top-level `name:`. The orchestrator exports COMPOSE_PROJECT_NAME=botss-$BOTSS_AGENT and
# per-agent DB_PORT, BACKEND_PORT, FRONTEND_PORT, so every agent's worktree gets its own stack.

services:
  db:
    image: postgres:16                      # pin to current; match CI
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-app}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-app}
      POSTGRES_DB: ${POSTGRES_DB:-app}
    ports: ["${DB_PORT:-5432}:5432"]
    volumes:
      - db-data:/var/lib/postgresql/data
      - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 3s
      timeout: 3s
      retries: 20

  migrate:
    build: ./backend
    command: ["alembic", "upgrade", "head"]
    env_file: .env
    environment:
      DATABASE_URL: postgresql+asyncpg://${POSTGRES_USER:-app}:${POSTGRES_PASSWORD:-app}@db:5432/${POSTGRES_DB:-app}
    depends_on:
      db: { condition: service_healthy }
    restart: "no"

  backend:
    build: ./backend
    command: ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
    env_file: .env
    environment:
      DATABASE_URL: postgresql+asyncpg://${POSTGRES_USER:-app}:${POSTGRES_PASSWORD:-app}@db:5432/${POSTGRES_DB:-app}
    ports: ["${BACKEND_PORT:-8000}:8000"]
    volumes:
      - ./backend/app:/app/app            # hot reload of source only; the image's .venv stays intact
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health/ready').status==200 else 1)"]
      interval: 5s
      timeout: 3s
      retries: 20

  frontend:
    build:
      context: ./frontend
      target: deps                         # dev: run the dev server on top of installed deps
    command: ["pnpm", "dev", "--hostname", "0.0.0.0", "--port", "3000"]
    env_file: .env
    environment:
      API_INTERNAL_URL: http://backend:8000
    ports: ["${FRONTEND_PORT:-3000}:3000"]
    volumes:
      - ./frontend:/app
      - frontend-node-modules:/app/node_modules   # keep container deps, not the host's
    depends_on:
      backend: { condition: service_healthy }

volumes:
  db-data:
  frontend-node-modules:
```

Notes:
* `$$` escapes `$` so the healthcheck reads the container's env.
* Parallel agents: the orchestrator exports `COMPOSE_PROJECT_NAME=botss-$BOTSS_AGENT` and per-agent `DB_PORT`, `BACKEND_PORT`, `FRONTEND_PORT` for every run, so each agent has its own containers, volumes, and ports. Never hardcode a project name or a host port; the defaults after `:-` are only for a human running the main checkout.
* Only ever stop, restart, or remove **your own** stack (the one `COMPOSE_PROJECT_NAME` names). Never touch containers or volumes of another project, and never pass `-p` with another agent's name.
* `docker compose up -d --wait` returns only when every healthcheck passes; use it in scripts and CI.

## 4. Postgres init script (test database)

```sql
-- infra/postgres/init/01-test-db.sql
CREATE DATABASE app_test;
```

Init scripts run only when the data volume is first created. After changing them, the volume must be recreated with `docker compose down -v`, which **deletes that stack's database**. Run it only on your own agent stack (check `echo $COMPOSE_PROJECT_NAME` first). For the main stack, ask `@human` before removing any volume, and say so in the handoff.

## 5. .dockerignore files

```gitignore
# backend/.dockerignore
.git
.venv
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/
.ruff_cache/
.coverage
htmlcov/
.env
.env.*
!.env.example
tests/
```

```gitignore
# frontend/.dockerignore
.git
node_modules
.next
out
coverage
playwright-report
test-results
.env
.env.*
!.env.example
```

Keep `tests/` out of the production backend image only if tests are not run inside that image; if CI runs tests in the container, build a separate `test` stage instead of removing the ignore.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Backend fails with "connection refused" at start | No healthcheck ordering | `depends_on: condition: service_healthy` on `db` |
| "relation does not exist" | Migrations not run | `migrate` service and `service_completed_successfully` |
| `ModuleNotFoundError` in container | Host `.venv` or `node_modules` copied over the built one | `.dockerignore`, named volume for `node_modules` |
| Every build reinstalls dependencies | Source copied before install | Copy manifests and lockfiles first |
| Frontend calls `localhost:8000` from inside a container | Server-side fetch using the browser URL | `API_INTERNAL_URL` for server-side calls; the browser uses relative `/api` paths via the rewrite |
| `NEXT_PUBLIC_` or rewrite change has no effect | Inlined at build time | Rebuild with the build arg |
| Port already allocated | Another agent's stack, or ports not exported | Check `COMPOSE_PROJECT_NAME` and the port vars the orchestrator set |
| Permission denied on mounted files | Non-root user vs host UID | Mount only source in dev, or set `user:` to the host UID in a dev override |
