---
"@quick-release/workbench": minor
---

The `SubmissionReviewAgent` now measures the review backlog on a schedule (ticket #33): waking an agent arms the Agents SDK's scheduler with one daily tick per repository that computes and persists the digest with no incoming request. The scheduler is an optimization, never a correctness dependency — a missed tick self-corrects on the next authenticated on-demand request, which recomputes from the current pending rows. The tick interval is a plain binding (`DIGEST_TICK_INTERVAL_SECONDS`, default 86,400 seconds) so the workerd suite drives it at one second through the runtime's alarm invocation.
