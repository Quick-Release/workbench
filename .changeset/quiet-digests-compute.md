---
"@quick-release/workbench": minor
---

`computeDigest` in `worker/digest.mjs`: a pure, runtime-free function that turns pending-submission rows into a maintainer digest — total count, fresh/aging/stale age buckets, oldest age, and an oldest-first item list — with `now` injected so the output is deterministic. This is the stable compute seam a future AI summarizer plugs into (#30).
