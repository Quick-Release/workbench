---
"@quick-release/workbench": minor
---

One-shot "draft description" AI endpoint on the dev server: `POST /api/ai/draft` returns a structured draft title and body for a pull request via one typed TanStack AI round-trip, assembled from the PR record plus the host repo's commit-subject style; `GET /api/ai/health` reports provider-key availability. Lands behind a shared, contract-tested loopback/same-origin request gate (#37).
