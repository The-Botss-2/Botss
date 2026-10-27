# PRD quality checklist

Run this against your draft before `botss doc submit`. Fix every failure, then run it again (up to three passes). In your progress note, list any item you deliberately left failing and why.

## Completeness
- [ ] Every user type in the journeys appears in the Users section, and vice versa.
- [ ] Every journey (UJ-n) is realized by at least one FR, and every FR names the journey it realizes.
- [ ] Every FR has acceptance criteria, including at least one failure, edge, or permission path.
- [ ] Every concern found in the concern scan has a decision (an FR, a non-goal, or an assumption).
- [ ] Every `[ASSUMPTION]` in the text is listed in the Assumptions index.
- [ ] Open questions each have an owner and say whether they block planning. No blocking question remains unless it is flagged for the owner.

## Clarity
- [ ] Glossary terms are used consistently; no synonyms for the same thing.
- [ ] No vague adjectives in requirements (fast, intuitive, robust, seamless, scalable, user-friendly, modern).
- [ ] No TODO, TBD, "???", or placeholder text.
- [ ] Each acceptance criterion can be checked by using the product, without reading code.
- [ ] Each FR describes one capability. Compound requirements ("can create, edit, and share reports") are split.

## Scope honesty
- [ ] P1 stories alone form a usable product someone could use end to end.
- [ ] Non-goals and MVP cuts list real temptations (things the owner or an engineer might assume are included), each with a reason.
- [ ] Nothing is described as "simplified", "basic version", or "for now" without saying what is deferred.
- [ ] The amount of P1 scope fits the stakes. A prototype with 25 P1 requirements is not a prototype.

## Substance over theater
- [ ] No invented facts: market sizes, competitor data, or user research you were not given.
- [ ] Personas and journeys change requirements; none exist just for color.
- [ ] Non-functional requirements are measurable and tied to the stakes, or omitted.
- [ ] Success metrics include at least one counter-metric.

## Boundaries
- [ ] No technology choices, database tables, API endpoints, or component names.
- [ ] Screens and data are described in user terms.
- [ ] Anything the owner said they want is either in scope or explicitly listed as a non-goal; nothing they asked for silently disappeared.

## Downstream test
Read the PRD as each teammate would:
- [ ] **Tech lead**: Could I list every entity, its states, and every screen without asking the PM?
- [ ] **Designer**: Do I know every screen, what it shows, and its empty and error states?
- [ ] **QA**: Could I write an end-to-end test for every acceptance criterion?
