---
name: engineering-discipline
description: Use for every Botss run that writes, changes, tests, or fixes code (backend, frontend, QA, DevOps, tech lead scaffolding), and whenever a test fails, a bug appears, review comments arrive, you feel stuck, or you are about to say a task is done or a test passes.
---

# Engineering Discipline

These habits separate an agent that ships working software from one that produces plausible-looking code that falls over in review. The most common agent failures are not lack of knowledge. They are skipping verification, guessing at bugs, quietly drifting out of scope, and looping on a broken approach. Each section explains why, so you can apply it to situations it does not list.

```
NO "DONE" WITHOUT FRESH EVIDENCE.  NO FIX WITHOUT A ROOT CAUSE.  NO CODE OUTSIDE THE TASK.
```

## 1. Understand before you type

1. Read the task's goal and acceptance criteria twice. Restate each criterion as a check you can run.
2. Read the context files the task names, and its **Consumes / Produces** block: the exact interfaces you rely on and the ones you must deliver. Those signatures are a promise to teammates working in parallel; match them exactly.
3. Find how the codebase already does the closest similar thing (an existing endpoint, component, or test) and follow that pattern. Consistency beats personal preference, because a reviewer and several other agents must read this code.
4. Record the base commit (`git rev-parse HEAD`) and run the existing test suite once before changing anything. A dirty baseline makes every later failure ambiguous; if the baseline is already red, report it before you start.

## 2. Test first

Write the test before the code for every behavior change: endpoints, business rules, components with logic, and bug fixes.

1. **Red.** Write one small test for the next behavior. Before running it, name the production change that would make it pass. Run it and confirm it *fails* (not errors) for the expected reason: the behavior is missing, not a typo or bad import. A test you never saw fail proves nothing.
2. **Green.** Write the simplest code that passes. No extra options or flexibility "for later".
3. **Refactor** while everything stays green.
4. Repeat. Every acceptance criterion maps to at least one test.

**Bug fixes** start with a test that reproduces the bug. If you cannot make it fail, you do not understand the bug yet. To prove a regression test works: run it (pass), temporarily revert the fix, run it (must fail), restore the fix.

**Good tests** exercise behavior through public interfaces (HTTP calls, rendered output, return values), use realistic data, derive expected values by hand rather than by calling the code under test, and read like requirements: `test_guest_cannot_view_other_users_orders`.

**Weak tests**, which reviewers will flag: asserting that a mock was called, mirroring the implementation, checking a constant's value or exact log wording, mocking the very thing being tested, or mocks whose data shape differs from the real thing. Mock only slow or external layers (third-party APIs, email, payment), never your own database layer in an integration test.

**Mutation check before handoff.** Imagine breaking the code in realistic ways: wrong constant, wrong branch, missing validation, empty result, skipped side effect. At least one test should fail for each. If none would, add the missing test.

Test-first is optional only for pure configuration, static markup without logic, generated code, and throwaway spikes. Say so in the handoff when you skip it. If code is hard to test, treat that as a design signal (too coupled), not an excuse.

## 3. Verify before you claim

Before writing "done", "fixed", "passing", or ticking a criterion:

1. Identify the command that proves the claim.
2. Run it now, in this run, in your worktree, completely.
3. Read the full output: exit code, summary line, warnings.
4. Only then make the claim, quoting the evidence (`47 passed in 3.1s`).

| Claim | Evidence required | Not evidence |
|---|---|---|
| Tests pass | Full suite for your area, exit 0, fresh | A partial run, a run before your last edit |
| Build works | The build command's exit 0 | Lint passing, the dev server starting |
| Bug fixed | The reproducing test now passes, and failed before | "The code looks right" |
| Criterion met | A specific test or command per criterion | All tests green in general |
| Endpoint works | A real request and its response | The handler compiling |

Your task's scope bounds what you *change*, not what you *verify*. Run the whole suite for your area before handoff. If anything is red, even a failure you did not cause, name it in the handoff and message its owner. Leaving it out is a false report.

Words that signal you are about to claim without evidence: "should", "probably", "seems to", "I believe", "Done!". Stop and run the command.

`botss task done` runs the task's `verify` command itself and refuses to complete on a non-zero exit, so verify first and save yourself the round trip.

## 4. Debug systematically

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

Trying fixes until one sticks creates new bugs and burns the owner's quota. Work in four phases, finishing each before the next:

1. **Root cause.** Read the whole error and stack trace. Reproduce it with the smallest reliable command. Check what changed: `git diff`, recent commits, new dependencies, env vars, unapplied migrations. In a multi-layer flow (UI to API to DB), log inputs and outputs at each boundary once to see where the value first goes wrong, then trace backwards from there.
2. **Pattern.** Find similar code that works and list every difference.
3. **Hypothesis.** Write one hypothesis down ("the cursor is double-encoded by the client"), make the smallest change that tests it, and observe. If wrong, revert before trying another. Change one variable at a time.
4. **Fix.** Write the failing test, make one fix at the cause (not the symptom), and run the suite.

**You are guessing if you:** say "let me just try", change several things at once, wrap code in `try/except: pass` or add `?.` chains to make an error vanish, raise a timeout to cure flakiness, or edit a test's expected value to match whatever the code now returns.

For timing problems, wait for a condition with a timeout (poll until the row exists, the element is visible) instead of sleeping a fixed time.

## 5. Decide, ask, or stop

Not every uncertainty needs a message. Headless teammates cannot answer instantly, so use the cheapest correct option:

* **Make a ruling** for small, reversible, local choices the task does not specify (a helper's name, the order of fields in an internal function, which existing utility to reuse). Decide, then record it in the handoff as `Ruling: what, why, cost if wrong`. Unrecorded deviations are decisions made in secret.
* **Ask** (`botss ask`) when the answer changes a contract, product behavior, security, data, or another agent's work. Include what you checked and a proposed default.
* **Stop** (`botss task block`) for destructive or irreversible actions, anything security-sensitive or involving secrets, external side effects (payments, emails to real people, publishing), or when every path forward would be a guess.

**Stuck** means three different fixes for the same problem have failed, or you have read file after file without progress. Three failed fixes signal a wrong assumption, not a need for a fourth fix. Then:
1. Stop editing and revert experiments that did not help.
2. Write down the exact error, each attempt, and what it showed.
3. Question the premise: is the contract wrong, the environment broken, the task impossible as written?
4. Ask the right teammate with that write-up, or block the task with it as the reason.

Being blocked with a clear write-up is a good outcome. Bad work is worse than no work.

Finish every run in one of four states: **DONE**, **DONE_WITH_CONCERNS** (works, but you have a specific worry, stated), or **NEEDS_CONTEXT** (the task is missing information, listed), each via `botss task done --status ...`; or **BLOCKED** (cannot proceed), which is never a `done` status: use `botss task block <id> --on <who> --reason ...` instead.

## 6. Stay in scope

* Do not add features, options, or abstractions the task did not ask for. Each one is code nobody planned, reviewed for, or tested against, and it widens merge conflicts.
* Do not refactor, rename, or reformat outside your task. Note it as a follow-up in the handoff instead.
* Do not change contracts, shared config, or dependencies without the tech lead agreeing.
* Do handle the edge cases the criteria imply (empty, invalid, unauthorized, error states). A working happy path is not done.
* If the task turns out bigger than planned, deliver a coherent slice, report DONE_WITH_CONCERNS, and propose a follow-up task rather than expanding silently.

## 7. Receiving review feedback

When your task comes back as `changes_requested`:
1. Read every comment before changing anything. If any item is unclear, ask about it before implementing any of them, because items are often related.
2. Fix in order: blocking issues first, then simple ones, then complex ones. Test each fix.
3. If a comment is wrong (the reviewer lacked context, or it asks for something unused), reply with technical reasoning and evidence instead of complying. Check real usage in the codebase before building something "properly".
4. Reply to each comment with what changed and the test that covers it. Skip the thanks and the "you're absolutely right"; state the fix.

## 8. Code quality basics

* Follow existing patterns, naming, and folder structure.
* Handle errors explicitly. Never swallow an exception; handle it meaningfully or let it reach a layer that can. Never fall back to fake or mock data in production code paths.
* No secrets in code. Read them from the environment and add the variable *name* to `.env.example`.
* Validate input at boundaries (API handlers, forms, env loading) and trust typed data inside.
* Remove dead code, commented-out code, and debug logging before handoff.
* Prefer clear names to comments. Comment the "why", never the "what".
* A new dependency needs a reason. Check the project does not already have one that does the job, and mention it in the handoff.

## 9. Commit discipline

* Commit at each green step or coherent slice: `T012: validate pagination cursor`. Stage explicit paths, not `git add -A`.
* Never commit failing tests on purpose, build output, `.env` files, or large binaries.
* Never force-push, rewrite shared history, merge into main, or delete worktrees. The orchestrator owns merges.
* Before handoff: `git status` is clean, and `git diff <base>...HEAD --stat` shows only files your task owns or allows. Use your recorded base, not `HEAD~1`, which hides earlier commits.

## 10. Rationalizations to reject

| If you catch yourself thinking | Reality |
|---|---|
| "Too simple to need a test" | Simple code breaks too; the test takes a minute |
| "I'll add tests after" | Tests written after pass by default and prove little |
| "It should work now" | Run it and read the output |
| "That failure isn't mine" | Report it by name anyway; omission is a false report |
| "The test is flaky, skip it" | Find why it is flaky, or report it |
| "Just tweak the expected value" | Find why the value differs |
| "I'll fix these minor things while I'm here" | Unrequested work; note it as a follow-up |
| "The contract is slightly off, I'll adapt" | Others code against it; ask the tech lead |
| "One more try will do it" (fourth time) | Past three, the problem is structural; follow the stuck procedure |

Violating the letter of these rules is violating their spirit. There is no clever exception.

## References

* `references/testing-patterns.md`: test structure, fixtures and factories, what to mock, async and time, flaky test causes and fixes, and test pollution.
