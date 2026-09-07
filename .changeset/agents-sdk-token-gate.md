---
"@quick-release/workbench": minor
---

The Cloudflare Agents SDK (pinned to `agents` 0.22.0) lands additively in the telemetry worker behind the existing ingest token gate: the `SubmissionReviewAgent` runs as a SQLite-backed Durable Object keyed one-instance-per-repository, its `/agents/submission-review-agent/<repo>` route mounts strictly after the constant-time bearer-token check (healthz stays unauthenticated), the alchemy stack declares the DO binding with the SQLite-class migration derived automatically, the bare-wrangler escape hatch carries the equivalent binding plus manual migration, and the dependency joins the Renovate weekly group (#31).
