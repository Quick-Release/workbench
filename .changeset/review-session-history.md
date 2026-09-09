---
"@quick-release/workbench": minor
---

Session run history with re-run (issue 27, epic 20). The dev server now records every finished review run — engine, PR, outcome (completed / failed / cancelled / timed out), duration, and the streamed output — and answers `GET /api/review/history` with the list, newest first, behind the shared request gate and the Effect Schema boundary. The pull-requests page lists the session's runs, re-opens any run's streamed result without re-running it, and re-runs an entry with one click through the normal start path (single-run-per-engine and the confirmation-free local posture unchanged). History is in-memory on the dev server only: a restart resets it, and an empty session renders its own empty state.
