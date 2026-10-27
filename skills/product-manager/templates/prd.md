# PRD: {Product name}

**Stakes:** Prototype | Internal tool | Launch
**Status:** Draft v{n}, {date}
**Owner:** {owner name}

## 1. Summary
Two or three sentences: what this is, who it is for, and the main outcome it gives them.

## 2. Glossary
| Term | Meaning |
|---|---|
| {Order} | {A request by a Customer for one or more Products, from checkout until delivered or cancelled} |

Use these exact words everywhere in this document.

## 3. Users
| User type | What they are trying to get done | Access |
|---|---|---|
| {Customer} | {Order lunch quickly from their phone} | {Own orders only} |

**Not for (this version):** {user types explicitly not served}

## 4. Core journeys
**UJ-1: {Short name}**
{Named person, situation.} {3 to 5 steps of what they do and see.} {The outcome.}
*Edge case:* {what happens when something goes wrong in this journey}

## 5. Requirements

### Story 1 (P1): {Story name}
**Why P1:** {why this slice comes first}
**Independent test:** {how someone can confirm this story works on its own}

**FR-1: {Actor} can {capability} {under conditions}.** Realizes UJ-1.
Acceptance criteria:
1. Given {state}, when {action}, then {observable result}.
2. Given {invalid or edge state}, when {action}, then {observable result}.
Out of scope: {closely related things this FR does not include}

**FR-2: ...**

### Story 2 (P2): {Story name}
...

## 6. Screens and content
| Screen | Shows | Main actions | Empty / error states |
|---|---|---|---|
| {Order list} | {date, total, status per order; newest first} | {open order, cancel pending order} | {"No orders yet" with link to menu} |

## 7. Business rules
* {Rule, stated precisely: "An Order can be cancelled only while Pending."}

## 8. Non-functional requirements
(Only measurable needs justified by the stakes. Delete this section for prototypes if nothing applies.)
* {NFR-1: ...}

## 9. Non-goals and MVP cuts
| Not in this version | Why |
|---|---|
| {In-app payments} | {Owner invoices separately; revisit in v2} |

## 10. Success metrics
* {Metric and target}
* **Counter-metric:** {what must not get worse, or must not be optimized}

## 11. Assumptions
| ID | Assumption | Where used |
|---|---|---|
| A-1 | {Users sign in with email and password} | FR-3 |

## 12. Open questions
| ID | Question | Owner | Blocks planning? |
|---|---|---|---|
| OQ-1 | {...} | {Owner / PM / Tech lead} | {Yes / No} |

## 13. Change log
| Date | Change | Reason |
|---|---|---|
| {date} | Initial draft | |
