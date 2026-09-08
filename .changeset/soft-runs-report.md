---
"@quick-release/workbench": minor
---

Telemetry and the Submission flow land (ticket #12): every sync now reports one payload per Developer per host repo per UTC day to the company endpoint — identity via `gh` falling back to git email (nullable), workbench version/OS/Node, session aggregates when the host's sessions opt-in is on (omitted otherwise), the Developer's GitHub Outcomes over a rolling 30 days (opened, merged, median time-to-merge), and buffered health errors. Daily dedup uses a git-ignored local marker; delivery failures are logged and swallowed; demo mode and an unconfigured endpoint send nothing. The Highlights page gains its Submit action: the browser POSTs the candidate to a localhost seam that attaches the repo remote and ingest token server-side and forwards to the Worker's review queue, with immediate per-candidate confirmation. ADR 0001 posture throughout — telemetry is numbers-only; content moves only through an explicit Submission.
