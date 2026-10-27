# Review output format

Start with the verdict. No preamble, no praise padding, no restating the task. Every line is a verdict, a finding, or a check you ran.

## Format

```markdown
# Review: {task id} {title} (round {n})

**Verdict:** APPROVE | REQUEST CHANGES | ESCALATE
**Spec compliance:** Complete | Missing / Extra / Misunderstood (list)
**Quality:** Clean | {n} blocker, {n} major, {n} minor

## Strengths
{One or two lines, specific. Skip if nothing notable.}

## Findings
### [blocker] {file}:{line} {short title}
**Problem:** {what is wrong}
**Consequence:** {what concretely happens, to whom, under which realistic input}
**Fix direction:** {how to fix, briefly; not a full patch}

### [major] ...
### [minor] ...
### [nit] ...

## Declined to judge
- {Requirement or behavior you could not verify from the diff, and why}

## Out of scope observations
- {Pre-existing or unrelated issues worth a follow-up task. These never affect the verdict.}

## Checks run
- {Named-risk checks you did outside the diff, one line each}
```

For a re-review, add a section before Findings:

```markdown
## Previous findings
- [blocker] orders.py:42 invalid cursor 500: ADDRESSED (orders.py:44, test_invalid_cursor)
- [major] no index on orders.user_id: NOT ADDRESSED (migration 0004 still has no index)
```

## Example

```markdown
# Review: T012 Orders list endpoint with cursor pagination (round 1)

**Verdict:** REQUEST CHANGES
**Spec compliance:** Missing: AC4 (invalid cursor returns 400). Misunderstood: tie-break ordering.
**Quality:** 1 blocker, 2 major, 1 minor

## Strengths
Ownership filter is inside the query, and the tests use real Postgres with factories.

## Findings
### [blocker] backend/app/services/order_service.py:31 Pagination skips or repeats orders with equal timestamps
**Problem:** The cursor encodes only `created_at`, and the query uses `created_at < :cursor`.
**Consequence:** Orders created in the same millisecond (bulk import, retries) are skipped on the next page. Customers will not see some of their orders. This violates AD-3 (stable sort with unique tie-breaker).
**Fix direction:** Encode `(created_at, id)` in the cursor and use a row comparison `(created_at, id) < (:ts, :id)`, ordered by both.

### [major] backend/app/api/orders.py:42 Malformed cursor returns 500
**Problem:** `decode_cursor` raises `ValueError` on bad base64, and nothing catches it.
**Consequence:** Any edited or truncated URL gives users a 500 page and logs an error; the contract requires 400 `invalid_cursor`.
**Fix direction:** Catch decoding errors and raise the standard `invalid_cursor` error. Add a test.

### [major] backend/tests/api/test_orders_list.py No test for the second page
**Problem:** Tests cover only the first page.
**Consequence:** AC2 (second page returns the remaining orders, `next_cursor` null) is unproven, and the blocker above went undetected.
**Fix direction:** Add a two-page test with 25 orders, including two that share a timestamp.

### [minor] backend/app/services/order_service.py:12 `limit` clamped silently
**Problem:** Values over 100 are clamped to 100 in the service, though the router already rejects them with 422.
**Consequence:** Two places define the limit and will drift.
**Fix direction:** Keep validation in the schema only.

## Declined to judge
- p95 latency claim in the handoff: cannot verify without a load test; measurement method looks reasonable.

## Out of scope observations
- `products.py` (unchanged) has the same timestamp-only cursor. Suggest a follow-up task.

## Checks run
- Checked `alembic/versions/0004`: composite index `(user_id, created_at)` exists.
- Checked frontend client `src/lib/api/orders.ts`: reads `next_cursor`, matches contract.
```
