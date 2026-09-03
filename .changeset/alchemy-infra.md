---
"@quick-release/workbench": patch
---

Deploy the telemetry ingest Worker and its D1 store with Alchemy (infrastructure-as-Effects): `alchemy.run.ts` is now the deploy surface (`pnpm worker:deploy` / `worker:dev` / `worker:tail`), `worker/schema.sql` moved to `worker/migrations/0001_init.sql` and is applied by deploys, and Effect moves to the v4 RC (`4.0.0-rc.112`). `worker/wrangler.jsonc` stays as the script-only escape hatch.
