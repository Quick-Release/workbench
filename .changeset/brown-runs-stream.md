---
"@quick-release/workbench": minor
---

Review run lifecycle (issue 26, epic 20): `POST /api/review` starts an engine run and streams the runner's typed events as server-sent events; `POST /api/review/cancel` stops it. The registry enforces one active run per engine with a typed busy rejection, a hung CLI run times out with a readable error, cancellation escalates from SIGTERM to SIGKILL so the process tree actually dies, and output is capped with a distinct truncation marker. The PR page grows per-PR review actions gated on each engine's health verdict, a live output panel, and the cancel affordance. Also here: the five API middlewares now share one guarded wrapper (URL parse, `next(error)` forwarding, one JSON writer), route tests are first-class, and the domain vocabulary records review engines and review runs.
