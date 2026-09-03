# Alchemy for infrastructure, Effect v4 RC for the app

Status: accepted

The research notes recommended waiting — [alchemy-adoption.md](../research/alchemy-adoption.md) said to stay on wrangler until Alchemy 2.0 stabilizes, and [effect-adoption.md](../research/effect-adoption.md) said to pin Effect v3 — because `alchemy` ships as a 2.0 beta and peer-depends on the Effect v4 RC. We decided to adopt both now anyway: the team wants infrastructure as typed TypeScript (stages, plan/apply, `alchemy dev` with a local D1 simulator) rather than a wrangler runbook, and we accept beta churn on an internal tool whose deployed surface is one Worker and one D1 database.

## Considered options

- **Stay on wrangler** (the research verdict) — rejected: a four-command manual runbook with no drift detection, and the team wants the deploy surface in the same language as the code.
- **Adopt Alchemy, keep Effect v3** — rejected: `alchemy` declares `effect >=4.0.0-rc.112` as a peer dependency, so the versions cannot be split.
- **Terraform** — rejected: splits infrastructure from application code, adds state management and a second language for a two-resource stack.

## Consequences

- `alchemy.run.ts` is the deploy surface (`pnpm worker:deploy` targets stage `prod`); the first prod run needs `--adopt` to take over the resources wrangler created. `worker/wrangler.jsonc` remains as the script-only escape hatch.
- `worker/schema.sql` moved to `worker/migrations/0001_init.sql`; schema changes ship as numbered migration files applied by Alchemy deploys, not ad-hoc `wrangler d1 execute`.
- The app is pinned to the Effect v4 RC (`4.0.0-rc.112`), overriding the v3 recommendation; RC breaking changes land as normal code changes in this repo. `src/schema.ts` already uses the v4 API (`Schema.Literals`).
- Alchemy beta releases can break the deploy tooling; the wrangler escape hatch and Cloudflare-side resources are the recovery path.
- The ADR 0001 telemetry contract is untouched: `worker.mjs` stays a plain fetch handler, and Alchemy's own runtime telemetry is opt-in OTel (no-op by default).
