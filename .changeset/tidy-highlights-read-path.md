---
"@quick-release/workbench": minor
---

Highlights (ticket #17): sync now reads the host repo's recent commit log with bodies and folds the v1 candidate set into the snapshot — messages with a body beyond the subject that reference a ticket or issue, capped to the most recent 30. A new read-only Highlights page renders the candidates (subject, body, author, date, ticket reference) behind an explainer card stating the consent posture: nothing leaves the machine until an explicit Submission. Entirely local — no network anywhere in the slice.
