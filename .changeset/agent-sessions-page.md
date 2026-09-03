---
"@quick-release/workbench": minor
---

Add an opt-in agent-sessions page. With a `sessions` block in
`workbench.config.json`, sync reads the local ZCode CLI session database
read-only (via the built-in `node:sqlite`, against a temporary copy) and the
new `/sessions` page charts output tokens per day and model share alongside a
sortable per-session rollup. Only aggregates, model ids, timestamps, and
session titles enter the git-ignored snapshot; prompts and responses are never
read.
