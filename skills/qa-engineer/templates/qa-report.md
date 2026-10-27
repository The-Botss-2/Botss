# QA report: {T012 Orders list endpoint with cursor pagination}

**Mode:** verify | release
**Result:** PASS | FAIL | GO | NO-GO
**Branch / commit:** {botss/T012-orders-list @ abc1234}
**Date:** {date}

## Summary
{One or two sentences: what was verified and the outcome. For FAIL, the most important reason.}

## Automated checks
| Check | Command | Result |
|---|---|---|
| Task verify | `{verify command}` | {9 passed, 0 failed} |
| Area suite | `{command}` | {124 passed, 0 failed} |
| Lint / types / build | `{commands}` | {clean} |
| E2E (existing) | `{command}` | {14 passed} |

Pre-existing failures not caused by this task: {none / list with test names}

## Acceptance criteria
| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | {Given 25 orders, first page returns 20 newest first with cursor} | PASS | {curl output in evidence/T012-ac1.txt} |
| 2 | {...} | FAIL | {BUG-031} |

## Silent inputs
| Situation | Expected | Observed | Result |
|---|---|---|---|
| {Two tabs cancel the same order} | {Second sees "already cancelled"} | {Second gets a blank 500 page} | FAIL (BUG-032) |

## Exploratory notes
{What you tried from the checklist, briefly, and anything notable that is not a bug.}

## Console and logs
{Errors or warnings seen in the browser console, network, or backend logs, or "none".}

## Bugs filed
| ID | Severity | Title |
|---|---|---|
| BUG-031 | major | {Second page repeats the last item of the first page} |

## Release only: open bugs and decision
| Severity | Open count | IDs |
|---|---|---|
| blocker | 0 | |
| major | 0 | |
| minor | 3 | |

**Decision:** {GO / NO-GO, and why. Note any risk the owner accepted.}
