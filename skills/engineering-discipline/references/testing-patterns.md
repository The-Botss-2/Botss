# Testing patterns

Read the section you need; you do not need all of it.

## Contents
1. Test structure
2. Test data: fixtures and factories
3. What to mock and what not to
4. Async code, time, and randomness
5. Flaky tests: causes and fixes
6. Test pollution
7. Choosing the test level

## 1. Test structure

Use Arrange, Act, Assert, with one behavior per test:

```python
async def test_list_orders_returns_newest_first(client, make_order, user):
    # Arrange
    old = await make_order(user=user, created_at=days_ago(2))
    new = await make_order(user=user, created_at=days_ago(1))
    # Act
    res = await client.get("/api/orders", headers=auth(user))
    # Assert
    assert res.status_code == 200
    assert [o["id"] for o in res.json()["items"]] == [new.id, old.id]
```

* Name tests after the behavior and condition: `test_<subject>_<behavior>_when_<condition>`.
* One reason to fail per test. Several asserts are fine if they check one behavior.
* No logic in tests (loops, branches computing expected values). Expected values are literals or obviously derived.
* Parametrize instead of copy-pasting: `@pytest.mark.parametrize` or `it.each`.

## 2. Test data: fixtures and factories

* Use **factories** (`make_order(**overrides)`) that build valid objects with sensible defaults, so each test states only the fields it cares about.
* Make fixture data **realistic and complete**: the same shape as production data. Partial mocks that omit fields hide bugs that appear with real data.
* Each test creates its own data. Never depend on data another test created or on test order.
* Database tests: run each test in a transaction that rolls back, or truncate tables between tests. Use a real Postgres (Docker), not SQLite, when the app runs on Postgres, because behavior differs (JSON, constraints, case sensitivity, concurrency).

## 3. What to mock and what not to

Mock at the **edges of your system**, never in the middle:

| Mock | Do not mock |
|---|---|
| Third-party HTTP APIs (payments, email, LLM APIs) | Your own database layer in integration tests |
| The clock, when testing time logic | Your own service functions called by the code under test |
| Randomness and ID generation, when output must be deterministic | The framework (FastAPI, React) |
| Slow infrastructure you cannot run locally | Pure functions |

Rules:
* Assert on **outcomes** (response body, database row, rendered text), not on "mock was called with X", unless the call *is* the behavior (for example "an email is sent").
* For outbound HTTP, prefer a request-level mock (`respx` for httpx, `msw` for fetch) over patching internal functions.
* If you need to mock five things to test one function, the function is doing too much. Say so in the handoff.

## 4. Async code, time, and randomness

* **Never sleep a fixed time to wait for something.** Wait for the condition with a timeout:

```python
async def wait_for(predicate, timeout=5.0, interval=0.05, what="condition"):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await predicate():
            return
        await asyncio.sleep(interval)
    raise AssertionError(f"Timed out after {timeout}s waiting for {what}")
```

  Playwright already does this: use `expect(locator).toBeVisible()` rather than `waitForTimeout`.
* A fixed delay is acceptable only when the behavior itself is timed (debounce, rate limit), with a comment saying so.
* Freeze or inject time (`freezegun`, `time-machine`, `vi.useFakeTimers()`) instead of relying on the real clock.
* Seed randomness or inject ID generators so outputs are reproducible.
* Use timezone-aware datetimes everywhere and test around midnight and DST boundaries when dates matter.

## 5. Flaky tests: causes and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Passes alone, fails in the suite | Shared state or test order dependence | Isolate data; see section 6 |
| Fails sometimes in CI only | Timing, fixed sleeps, slower machine | Condition-based waits |
| Fails around certain dates or times | Real clock, timezones | Freeze or inject time |
| Order of list items differs | Unordered query or set iteration | Sort in the query, or compare as sets when order is irrelevant |
| E2E element not found | Waiting on time, not state; brittle selectors | Web-first assertions; role or test-id selectors |
| Port or file already in use | Leftover processes or files | Random ports, temp dirs, proper teardown |

Never "fix" flakiness by adding retries, raising timeouts, or skipping the test without a ticket. A flaky test is either a test bug or a real race condition in the product, and both matter.

## 6. Test pollution

When a test fails only after other tests run, something earlier left state behind (database rows, files, environment variables, module-level caches, mocked globals not restored). To find the polluter, bisect: run the failing test together with the first half of the earlier tests, then the second half, and keep halving until one test remains. Then fix that test's teardown.

Prevent it: transactional DB fixtures, `tmp_path` for files, `monkeypatch` for env vars (auto-restored), and clearing caches in fixtures.

## 7. Choosing the test level

* **Unit tests** for pure logic: calculations, validation rules, formatting, reducers. Fast and many.
* **Integration tests** for API endpoints with a real database, and components with real child components. These give the most confidence per test for typical web apps; make them the default for backend endpoints.
* **End-to-end tests** (Playwright) for the few critical user journeys: sign up, log in, the main create/read/update flow, checkout. Slow and few.

A useful default for a web app: every endpoint has integration tests for success, validation error, unauthorized, forbidden, and not found; every critical journey has one E2E test; logic-heavy functions have unit tests.
