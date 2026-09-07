---
"@quick-release/workbench": minor
---

The `SubmissionReviewAgent` now serves the digest (ticket #32): an authenticated request to `/agents/submission-review-agent/<repo>` returns the repository's pending-submission digest — computed by the pure `computeDigest` from rows read through the existing D1 binding — alongside the previous run's persisted digest, so each on-demand run reports what changed since the last review pass. The worker test harness applies the D1 migrations to the workerd suite's database via the plugin's `readD1Migrations`/`applyD1Migrations` pattern.
