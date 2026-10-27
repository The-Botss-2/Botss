---
id: T012
title: Orders list endpoint with cursor pagination
role: backend
story: S1          # PRD story
covers: [FR-4]
after: [T004, T007]          # real prerequisites only
owns:
  - backend/app/api/orders.py
  - backend/app/services/order_service.py
  - backend/tests/api/test_orders_list.py
may_touch:
  - backend/app/api/router.py        # register route; owner T000
verify: "cd backend && DATABASE_URL=\"$TEST_DATABASE_URL\" uv run alembic upgrade head && uv run pytest tests/api/test_orders_list.py -q && uv run ruff check . && uv run mypy app"   # works without make
size: M            # S (1 to 2 files), M (3 to 6), L (split it)
---

## Goal
Customers can see their own orders, newest first, a page at a time. When done, GET /api/orders returns the signed-in user's orders using the standard cursor pagination.

## Context
- PRD: FR-4, UJ-2
- Architecture: AD-3 (pagination), Conventions > Errors
- Contract: `contracts/openapi.yaml` > `GET /api/orders`, schema `OrderListResponse`
- Pattern to follow: `backend/app/api/products.py` (list endpoint built in T007)

## Consumes
- `Order` model and `orders` table (T004)
- `get_current_user` dependency from `app/core/security.py` (T000)

## Produces
- `GET /api/orders?limit=&cursor=` returning `OrderListResponse`:
  `{"items": OrderRead[], "next_cursor": string | null}`
- `order_service.list_orders(session, user_id, limit, cursor) -> tuple[list[Order], str | None]`

## Contract constraints (quoted)
- `limit`: integer 1 to 100, default 20
- Sort: `created_at desc, id desc`
- Invalid cursor: 400 with `error.code = "invalid_cursor"`

## Boundaries
- Always: filter by the current user in the query, not after fetching.
- Never: change the `Order` model or migrations (owned by T004); return other users' orders; use offset pagination.

## Edge cases
| Input | Expected |
|---|---|
| No orders | 200, `items: []`, `next_cursor: null` |
| limit=0 or 101 | 422 with field error on `limit` |
| Malformed cursor | 400 `invalid_cursor` |
| Not signed in | 401 |
| Exactly `limit` orders exist | `next_cursor: null` (no empty extra page) |

## Acceptance criteria
1. Given a signed-in user with 25 orders, when they GET /api/orders, then 20 orders return newest first with a non-null `next_cursor`.
2. Given that cursor, when they request the next page, then the remaining 5 return and `next_cursor` is null.
3. Given another user's orders exist, when the user lists orders, then none of the other user's orders appear.
4. Given a malformed cursor, when they request, then they get 400 with code `invalid_cursor`.

## Notes
{Anything else the agent must know. Keep the whole file under about 1,600 tokens.}
