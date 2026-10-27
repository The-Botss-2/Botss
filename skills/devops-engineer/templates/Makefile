# Standard commands for the whole team. CI calls these same targets.
# The tech lead copies these into task `verify` fields: do not rename targets without telling them.
# Recipes must be indented with a tab character.

SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose

# Per-agent values come from the environment (the orchestrator exports them); `?=` keeps them.
# The defaults are only for a human running the main checkout.
DB_PORT ?= 5432
TEST_DATABASE_URL ?= postgresql+asyncpg://app:app@localhost:$(DB_PORT)/app_test
export DB_PORT TEST_DATABASE_URL

.PHONY: help up down logs ps migrate migration test test-backend test-frontend e2e lint format typecheck build check clean

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

up: ## Start the full stack and wait until healthy
	@test -f .env || cp .env.example .env
	$(COMPOSE) up -d --build --wait

down: ## Stop the stack (keeps data)
	$(COMPOSE) down

logs: ## Follow logs
	$(COMPOSE) logs -f --tail=100

ps: ## Show service status
	$(COMPOSE) ps

migrate: ## Apply database migrations
	$(COMPOSE) run --rm migrate

migration: ## Create a migration: make migration m="add orders table"
	cd backend && uv run alembic revision --autogenerate -m "$(m)"

test: test-backend test-frontend ## Run all unit and integration tests

test-backend: ## Backend tests against the test database (TEST_DATABASE_URL)
	cd backend && DATABASE_URL="$$TEST_DATABASE_URL" uv run alembic upgrade head && uv run pytest -q

test-frontend: ## Frontend unit and component tests
	cd frontend && pnpm test -- --run

e2e: ## Playwright end-to-end tests (Playwright's webServer starts the servers)
	cd e2e && pnpm exec playwright test

lint: ## Lint and format-check everything
	cd backend && uv run ruff check . && uv run ruff format --check .
	cd frontend && pnpm lint

format: ## Auto-format everything
	cd backend && uv run ruff format . && uv run ruff check --fix .
	cd frontend && pnpm format

typecheck: ## Type-check backend and frontend
	cd backend && uv run mypy app
	cd frontend && pnpm typecheck

build: ## Build production images
	$(COMPOSE) build

check: lint typecheck test ## What CI runs before e2e

clean: ## Stop THIS stack and DELETE its data volumes (agent stacks only, or CONFIRM=yes)
	@if [[ "$${COMPOSE_PROJECT_NAME:-}" != botss-* && "$(CONFIRM)" != "yes" ]]; then \
	  echo "Refusing: this is not an agent stack. Agents must ask @human first; a human may run: make clean CONFIRM=yes"; exit 1; fi
	$(COMPOSE) down -v
