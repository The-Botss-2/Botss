# Security audit: {Product name} {release or branch}

**Branch / commit:** {integration @ abc1234}
**Date:** {date}
**Environment tested:** local docker compose stack only
**Recommendation:** Release | Release after fixes | Do not release

## Summary
{Two or three sentences: overall posture, the most important findings, and what must happen before release.}

| Rating | Open | Fixed during audit |
|---|---|---|
| Critical | 0 | 0 |
| High | 1 | 0 |
| Medium | 2 | 0 |
| Low | 3 | 0 |

## Findings

### SEC-1 [High] Customer can read other customers' orders
**Where:** `GET /api/orders/{id}`, `backend/app/api/orders.py:58`
**Attack path:** Any signed-in customer changes the order ID in the URL or request.
**Proof (local stack):**
```
# signed in as user A
GET /api/orders/7f3c...b21 (order owned by user B)
200 {"id": "7f3c...b21", "customer_name": "B", "address": "..."}
```
**Impact:** Disclosure of any customer's name, address, and order history.
**Fix:** Scope the query by `user_id` (`WHERE id = :id AND user_id = :current`) and return 404 when not found.
**Verify with:** test `test_cannot_read_other_users_order` (A requests B's order, expect 404).
**Bug:** BUG-044 on T013

### SEC-2 [Medium] ...

## Automated scan results
| Tool | Command | Result | Notes |
|---|---|---|---|
| pip-audit | `pip-audit` | 1 finding | {pkg x.y CVE-...: not reachable (dev dependency); dismissed} |
| pnpm audit | `pnpm audit --prod` | 0 | |
| gitleaks | `gitleaks detect` | 0 | |
| semgrep | `semgrep --config p/python --config p/typescript --metrics=off` | 4 | {3 false positives (reasons below), 1 reported as SEC-3} |
| trivy | `trivy image app-backend` | 2 medium | {base image packages; update base image tag} |

**Dismissed results:** {one line each with reason}

## Tested and passed
{Areas from the checklist you tested that showed no issue, briefly, so readers know what was covered.}
- Authentication required on all 23 non-public routes (enumerated from routers)
- Session cookie flags correct
- No secrets in client bundle

## Needs investigation
{Suspicions you could not prove or disprove, with what you checked.}

## Not tested
{Areas out of scope or not possible locally, e.g. production TLS configuration, cloud IAM.}
