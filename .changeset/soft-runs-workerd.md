---
"@quick-release/workbench": patch
---

The ingest worker's HTTP contract is now behaviorally tested inside the real workerd runtime via `@cloudflare/vitest-pool-workers`, running under the standard `pnpm test` command beside the existing runtime-free suites; the vitest config gains a two-project split (dashboard pool + workers pool) with the dashboard project carrying its own plugins and alias (#29).
