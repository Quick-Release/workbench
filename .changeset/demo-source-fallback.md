---
"@quick-release/workbench": patch
---

Standalone checkouts now choose their data source explicitly: `pnpm dev` reads this repository's own planning sources, while `pnpm dev:demo` (or `WORKBENCH_DEMO_SOURCE=1`, optionally any checkout path) reads the demo checkout at `~/workspaces/getquick/banquinha` for a larger ticket corpus. Host repositories always ignore the demo source.
