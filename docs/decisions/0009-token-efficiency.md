# 0009: Keeping agent communication cheap

**Status:** accepted · 2026-10-27

Every token comes from the owner's subscription, so the plumbing between agents is designed to waste as little as possible:

1. **Stable system prompt per role.** `system.md` holds only the role's skills and a generic header (no agent id, task, or mode), so it is byte-identical for every run of that role and Claude Code's prompt cache is reused across runs and agents. Identity, task, and mode go in the first user message.
2. **Lean run prompts.** The task file is included; everything else is referenced by path. At most 8 unread messages are inlined, each capped at 600 characters (`botss inbox` has the rest).
3. **Message caps.** `botss msg`, `ask`, and `reply` reject bodies over 2,000 characters with a hint to put detail in a file and send the path.
4. **Batched answers.** Questions to the same role that arrive before its answer run starts are merged into one answer task, so one run answers several questions.
5. **Resume, don't restart.** Answers, review comments, QA bugs, usage-limit pauses, and the kill switch all resume the agent's own session (`--resume`) rather than starting a fresh one that must re-read everything.
6. **Files over threads.** The team protocol tells agents to record decisions and contract changes in files that later runs read once, and to skip acknowledgements and narration.
7. **Scope discipline.** Every role builds only what the owner asked for; unrequested work is the largest avoidable cost.
