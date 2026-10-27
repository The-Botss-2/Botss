# {Short, specific title: "Second page of orders repeats the last item of the first page"}

**Severity:** blocker | major | minor | trivial
**Task:** {T012}  |  **Requirement:** {FR-4, AC 2}
**Found in:** {branch @ commit}  |  **Environment:** {local docker compose, Chromium 130, 1440x900}
**Reproducible:** always | intermittent ({3 of 5 tries}) | observed once

## Steps to reproduce
1. {Sign in as a new user}
2. {Create 25 orders (`POST /api/test/orders?count=25`)}
3. {GET /api/orders?limit=20, take next_cursor}
4. {GET /api/orders?limit=20&cursor=<that cursor>}

## Expected
{The remaining 5 orders, none of them already shown on page 1. Per FR-4 AC 2.}

## Actual
{6 orders returned; the first is the same as the last order on page 1.}

## Evidence
- {Request and response: evidence/BUG-031.txt}
- {Screenshot or trace path}
- {Relevant log lines}

## Failing test
{Path and name of a test that reproduces it, if written: `backend/tests/api/test_orders_list.py::test_second_page_has_no_overlap` (currently fails). If QA cannot add it in owned paths, describe the test so the owner can.}

## Notes
{Suspected area, only if you have evidence ("cursor encodes created_at only, not id; two orders share a timestamp"). Do not guess at causes you have not observed.}

## Fix acceptance
- [ ] The failing test above passes.
- [ ] The original task's acceptance criteria still pass.
