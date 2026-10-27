# Discovery: finding the gaps that matter

## 1. Stakes probe

| Stakes | Signals | PRD depth |
|---|---|---|
| Prototype | "demo", "try out", "for me", hackathon, no real users | 1 to 2 pages; skip NFRs and metrics beyond one line |
| Internal tool | "my team", "our staff", a known group, no public signup | 2 to 4 pages; roles and permissions matter; light NFRs |
| Launch | real customers, payments, public signup, personal or health data | Full; security, privacy, and reliability needs are explicit |

If the idea does not make it clear, this is your first question.

## 2. Concern scan

For each concern present in the idea, a decision is needed (asked or assumed):

| Concern | Decision needed |
|---|---|
| Accounts | Who signs up? Email+password, magic link, Google? Is guest use allowed? |
| Multiple roles | Which roles exist, and what can each see and do? |
| Multi-tenancy | Do separate organizations share the app with isolated data? |
| Payments | One-off or subscription? Which provider? Refunds? Test mode only for MVP? |
| Personal or sensitive data | What is stored, who can see it, deletion and export? |
| Files and media | Upload types and size limits; where shown? |
| Notifications | Email, in-app, push, SMS? Which events trigger them? |
| Real-time | Do users need live updates (chat, dashboards), or is refresh fine? |
| Integrations | Which external systems, read or write, and what happens when they fail? |
| Admin back office | Does the owner need to manage users, content, or orders? |
| Mobile | Responsive web enough, or native app? |
| Localization | Languages, right-to-left scripts, currencies, time zones? |
| Compliance | GDPR, HIPAA, PCI, age limits, data residency? |

## 3. Coverage taxonomy

Mark each Clear, Partial, or Missing before choosing questions:

1. **Functional scope**: core capabilities, what is explicitly out.
2. **Users and roles**: who, how many kinds, permissions.
3. **Domain and data**: the main things the app stores, their life cycle and states (draft, active, archived), uniqueness rules, expected volume.
4. **Core journeys**: the main flows end to end, including what happens on error, empty, and loading states.
5. **Business rules**: limits, calculations, approvals, time windows.
6. **Integrations and failure modes**: external services and what the user sees when they are down.
7. **Edge cases**: concurrent edits, duplicates, deletion with dependents, rate limits.
8. **Non-functional needs** (only if stakes demand): performance, availability, security, privacy, accessibility.
9. **Constraints**: deadline, budget, must-use technology or hosting, branding.
10. **Done signals**: how the owner will judge the MVP a success.

## 4. Choosing questions

Score candidate questions by **impact** (how much the product, scope, or architecture changes between answers) multiplied by **uncertainty** (how unsure you are what the owner wants). Keep the top 7 at most. Typical high scorers: who the users and roles are, whether payments are in the MVP, multi-tenancy, the one core journey that defines the product, and anything legal or compliance related.

Do not ask (assume and tag instead):
* Standard auth details (password rules, session length, reset flow)
* Error message wording, pagination sizes, sort orders
* Generic performance targets for prototypes
* Anything technical (stack, hosting, database)
* Things already stated or clearly implied in the idea

## 5. Question format

Write `.botss/docs/discovery/questions.json`:

```json
{
  "intro": "Six quick decisions before I draft the PRD. Reply 'accept all' to take my recommendations.",
  "questions": [
    {
      "id": "Q1",
      "topic": "Users",
      "question": "Who uses the app?",
      "options": [
        {"key": "A", "label": "Only you (single owner)"},
        {"key": "B", "label": "Your staff, each with their own login"},
        {"key": "C", "label": "Your staff plus your customers"}
      ],
      "recommended": "B",
      "why_it_matters": "Decides whether we need roles and permissions, which roughly doubles the auth work."
    }
  ]
}
```

Rules:
* One decision per question. No compound "and/or" questions.
* Options are mutually exclusive, short, and concrete. Allow a free-text answer implicitly.
* The recommendation is what you would choose for this owner's stated goal, with the reason in `why_it_matters` or a short note.
* Order questions by impact, highest first.

**Good:** "Do customers pay inside the app in the first version? A: Yes, card payments via Stripe. B: No, you invoice them outside the app. Recommended: B. Payments add about a third more work and need a business Stripe account; you can add them in version 2."

**Bad:** "Can you tell me more about your payment requirements?" (open-ended, no options, no recommendation)

**Bad:** "Should we use PostgreSQL or MongoDB?" (technical; belongs to the tech lead)

## 6. Recording answers

When answers arrive, write them into `.botss/docs/discovery/answers.md` as `Q1: <question> -> <answer>` and apply each one to the draft immediately. If an answer contradicts something in the idea text, the answer wins; note the change.
