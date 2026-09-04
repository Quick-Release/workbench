---
"@quick-release/workbench": patch
---

Load environment variables through dotenvx. Package scripts (`sync`, `worker:*`, and the demo entries) run via `dotenvx run`; the new gitignored `.env` is seeded from `.env.example` on first run, and the committed `.env.demo` replaces the inline `WORKBENCH_DEMO_SOURCE=1` prefix. Dev-workflow only — the published CLI and host repositories are unchanged.
