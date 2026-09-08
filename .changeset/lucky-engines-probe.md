---
"@quick-release/workbench": minor
---

Engine health checks with actionable setup guidance (issue 24, epic 20). New review-runner seam: `scripts/review-runner.mjs` probes the CodeRabbit and zcode CLIs through an injected spawn — binary found (with version), auth / provider status — as typed states, never running a review. The dev server answers `GET /api/review/health` behind the shared request gate with the payload validated at the Effect Schema boundary, and the pull-requests page probes it on load: each engine renders ready or not-ready with its one-step remediation command (`brew install coderabbit`, `coderabbit auth login --api-key …`, `zcode login`), and a not-ready engine is given no start affordance.
