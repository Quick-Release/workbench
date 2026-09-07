---
"@quick-release/workbench": patch
---

The `SubmissionReviewAgent` digest route is hardened (#32 review follow-ups): concurrent digest runs for one repository are serialized around the D1 round-trip so the previous-run chain cannot scramble, non-GET methods answer `405` instead of triggering a run, and a repository identity that does not percent-decode answers `400` instead of an unhandled 500.
