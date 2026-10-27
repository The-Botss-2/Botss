# CI with GitHub Actions

A complete starting workflow for the default stack, plus the rules behind it. Version numbers and action versions are placeholders: **pin to current**.

## Contents
1. Pinning actions to SHAs
2. The CI workflow
3. Why it is shaped this way
4. Deploy jobs (only when the architecture names a target)
5. Checking a workflow locally

## 1. Pinning actions to SHAs

Every third-party action is pinned to a full commit SHA with the version as a comment:

```yaml
- uses: actions/checkout@<full-40-char-commit-sha> # v4.x.y
```

Tags can be moved to point at different code; SHAs cannot. Get the SHA for a tag with:

```bash
gh api repos/actions/checkout/commits/v4 --jq .sha
```

Or run a pinning tool such as `pinact` or `ratchet` over the workflow. Below, `@SHA` stands for that pinned SHA. Never commit the literal text `@SHA`.

## 2. The CI workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  PYTHON_VERSION: "3.12"     # pin to current; match the backend image
  NODE_VERSION: "22"         # pin to current LTS; match the frontend image

jobs:
  backend:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults: { run: { working-directory: backend } }
    services:
      db:
        image: postgres:16   # pin to current; match docker-compose
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: app_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U app -d app_test"
          --health-interval 3s --health-timeout 3s --health-retries 20
    env:
      DATABASE_URL: postgresql+asyncpg://app:app@localhost:5432/app_test
      TEST_DATABASE_URL: postgresql+asyncpg://app:app@localhost:5432/app_test
      ENVIRONMENT: ci
    steps:
      - uses: actions/checkout@SHA # v4
      - uses: astral-sh/setup-uv@SHA # v5
        with:
          enable-cache: true
          python-version: ${{ env.PYTHON_VERSION }}
      - run: uv sync --frozen
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run mypy app
      - run: uv run alembic upgrade head
      - run: uv run alembic check          # fails if models and migrations drift
      - run: uv run pytest -q
      - name: Dependency audit
        # audit the project's locked dependencies, not pip-audit's own environment
        run: |
          uv export --frozen --no-emit-project --format requirements-txt -o /tmp/requirements.txt
          uvx pip-audit --strict -r /tmp/requirements.txt

  frontend:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults: { run: { working-directory: frontend } }
    steps:
      - uses: actions/checkout@SHA # v4
      - uses: pnpm/action-setup@SHA # v4
        with:
          # there is no root package.json; read packageManager from the frontend
          package_json_file: frontend/package.json
      - uses: actions/setup-node@SHA # v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint                     # runs eslint directly; Next 16 removed `next lint`
      - run: pnpm typecheck
      - run: pnpm test -- --run
      - run: pnpm build
        env:
          API_INTERNAL_URL: http://localhost:8000   # target of the /api rewrite, baked in at build
      - name: Dependency audit
        run: pnpm audit --prod --audit-level=high

  secrets:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@SHA # v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@SHA # v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # required for repositories owned by an organization; free for personal repos.
          # If the owner has no license, replace this step with the gitleaks CLI:
          #   docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest git /repo
          GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}

  e2e:
    needs: [backend, frontend]
    runs-on: ubuntu-latest
    timeout-minutes: 25
    services:
      db:
        image: postgres:16   # pin to current
        env: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U app -d app"
          --health-interval 3s --health-timeout 3s --health-retries 20
    env:
      # ENVIRONMENT=test registers the seed and fault-injection routers e2e tests need.
      ENVIRONMENT: test
      DATABASE_URL: postgresql+asyncpg://app:app@localhost:5432/app
      API_INTERNAL_URL: http://localhost:8000
      E2E_BASE_URL: http://localhost:3000
    steps:
      - uses: actions/checkout@SHA # v4
      - uses: astral-sh/setup-uv@SHA # v5
        with: { enable-cache: true, python-version: "${{ env.PYTHON_VERSION }}" }
      - uses: pnpm/action-setup@SHA # v4
        with: { package_json_file: frontend/package.json }
      - uses: actions/setup-node@SHA # v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm
          cache-dependency-path: |
            frontend/pnpm-lock.yaml
            e2e/pnpm-lock.yaml
      - name: Install dependencies
        run: |
          (cd backend && uv sync --frozen --no-dev)
          (cd frontend && pnpm install --frozen-lockfile)
          (cd e2e && pnpm install --frozen-lockfile && pnpm exec playwright install --with-deps chromium)
      - name: Run Playwright
        # Playwright's webServer config starts both servers (backend: migrate + uvicorn;
        # frontend: `pnpm build && pnpm start` because CI is set) and waits for
        # http://localhost:8000/api/health/ready and http://localhost:3000. Do not start
        # them here as well, or the ports collide.
        working-directory: e2e
        run: pnpm exec playwright test
      - uses: actions/upload-artifact@SHA # v4
        if: failure()
        with:
          name: playwright-report
          path: |
            e2e/playwright-report
            e2e/test-results
          retention-days: 7
```

Adjust the commands to the project's Make targets. CI and agents should run the same commands; if the Makefile wraps them (`make test-backend`), call the Make targets here instead.

Playwright owns starting the servers, in CI and locally, through `webServer` in `e2e/playwright.config.ts` (`reuseExistingServer: !process.env.CI`). The QA skill's `references/playwright-patterns.md` has the config. CI only provides Postgres, dependencies, and env.

## 3. Why it is shaped this way

* `permissions: contents: read` at the top, extra permissions per job only when needed (for example `packages: write` for pushing images, `id-token: write` for OIDC).
* `concurrency` cancels superseded runs on the same branch.
* Postgres runs as a service container, the same major version as Compose, because tests against SQLite or another version miss real bugs.
* `alembic check` catches models changed without a migration.
* E2E uses `pnpm build && pnpm start`, not `pnpm dev`, because dev mode compiles routes on demand and makes tests slow and flaky.
* `timeout-minutes` on every job, so a hung job cannot burn hours.
* Audits and secret scanning are gates. If an audit fails on a vulnerability with no fix available, the owner of the dependency documents an exception rather than deleting the step.
* Artifacts (Playwright traces and reports) upload only on failure, which is when someone needs them.

## 4. Deploy jobs (only when the architecture names a target)

```yaml
  build-image:
    if: github.ref == 'refs/heads/main'
    needs: [backend, frontend, e2e]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@SHA # v4
      - uses: docker/setup-buildx-action@SHA # v3
      - uses: docker/login-action@SHA # v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@SHA # v6
        with:
          context: backend
          push: true
          tags: ghcr.io/${{ github.repository }}/backend:${{ github.sha }}
          cache-from: type=gha,scope=backend
          cache-to: type=gha,mode=max,scope=backend

  deploy-production:
    needs: build-image
    runs-on: ubuntu-latest
    environment: production          # required reviewers configured in repo settings
    permissions:
      contents: read
      id-token: write                # OIDC: no long-lived cloud keys in secrets
    steps:
      - uses: aws-actions/configure-aws-credentials@SHA # v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      # 1) run migrations (additive only) with the new image
      # 2) roll out the new image tag
      # 3) wait for the readiness check; roll back to the previous tag if it fails
```

Rules:
* Build once, tag with the commit SHA, promote the same image. Never rebuild per environment, except frontend images: `NEXT_PUBLIC_*` values and the `/api` rewrite target are baked in at build time, so a frontend image is built per environment unless every environment uses the same internal backend address.
* The production environment requires a reviewer. An environment with no reviewer assigned waits forever, so confirm the setup with the owner.
* Ask `@human` before creating any deploy pipeline that spends money or touches a real domain.

## 5. Checking a workflow locally

```bash
actionlint                                  # syntax and common mistakes
make check                                  # the same commands the jobs run
act pull_request -j backend                 # optional, if act and Docker are available
```

`act` does not perfectly emulate GitHub's runners; treat a pass as a strong hint, not proof. State in the handoff that the workflow itself only runs for real on GitHub.
