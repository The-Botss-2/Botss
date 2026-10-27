# Handoff note template

Copy this into `.botss/handoffs/<task-id>.md` (a gitignored scratch folder, so it is never committed or merged) and fill it in. Pass it with `botss task done <id> --handoff .botss/handoffs/<id>.md`. Keep it under one screen where you can. Delete any section that genuinely does not apply rather than writing "N/A" everywhere.

```markdown
# Handoff: T012 Orders list endpoint with pagination

**Status:** DONE  |  **Base:** a1b2c3d  |  **Head:** e4f5a6b

## What changed
Added GET /api/orders with cursor pagination, plus the Order read schema and a
composite index on (user_id, created_at). Files:
- app/api/orders.py (new)
- app/schemas/order.py (new)
- alembic/versions/0004_orders_index.py (new)
- tests/api/test_orders_list.py (new)

## How to verify
    docker compose up -d db
    uv run alembic upgrade head
    uv run pytest tests/api/test_orders_list.py -q     # expect: 9 passed
    curl -s localhost:8000/api/orders?limit=2 -H "Cookie: botss_session=..." | jq
    # expect: {"items":[...2 items...],"next_cursor":"..."}

## Acceptance criteria
- [x] Returns only the current user's orders: test_list_only_own_orders
- [x] Newest first, limit 1 to 100, default 20: test_ordering, test_limit_bounds
- [x] Invalid cursor returns 400 with standard error body: test_invalid_cursor
- [x] p95 under 50 ms with 10k rows locally: measured 18 ms (see note below)

## Decisions and deviations
- Used cursor pagination instead of page numbers (decision D-007, approved by tech lead).
- Contract changed: added `next_cursor` (nullable). Frontend notified (message M-0031).
- Ruling: put cursor encoding in `app/core/pagination.py` rather than the service, because T019 will reuse it. Cost if wrong: one small move.

## Known gaps and follow-ups
- No filtering by status yet; task T019 covers it.
- Timing measured on a laptop with local Postgres, not a production-like setup.
```

## What makes a handoff good

* **Verifiable.** The reader can copy the commands and see the same result.
* **Honest.** Gaps are listed. "Tests pass" means you ran them in this run.
* **Scoped.** It describes this task only, not your whole reasoning process.
* **Linked.** It mentions decision IDs, message IDs, and follow-up tasks so the dashboard can connect them.
