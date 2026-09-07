# Workbench ingest endpoint

The company-owned Cloudflare Worker + D1 store behind workbench Telemetry
and Content sourcing submissions (ADR 0001). The ingest handler
(`ingest.mjs`) is a pure fetch function — the runtime-free tests drive it
directly with an in-memory D1 double, no runtime needed. The deploy entry
(`worker.mjs`) bundles that handler with the Agents SDK and mounts its
routes behind the same bearer-token gate; the SDK is exercised through the
HTTP seam in workerd (`*.runtime.test.mjs`).

## Routes

- `POST /telemetry` — one payload per Developer per host repo per UTC day;
  duplicates (same day, repo, identity) answer `409`.
- `POST /submissions` — one Developer-submitted commit message; duplicates
  (same repo, sha) answer `409`; rows land with `status = 'pending'` for
  marketing review.
- `/agents/submission-review-agent/<repo>` — the Cloudflare Agents SDK
  route (ticket #31), served by the `SubmissionReviewAgent` Durable
  Object (SQLite-backed, one instance per repository identity, carried
  percent-encoded in the URL). It mounts strictly behind the same bearer
  token as the POST routes; without a token it answers `401`.
- `GET /healthz` — liveness, no auth.

Both POST routes require `Authorization: Bearer <token>`; the token is the
shared ingest secret (set as the `TELEMETRY_INGEST_TOKEN` secret here and
baked into the workbench package, whose GitHub Packages registry is the
company boundary). The agent route requires the same token — agent
endpoints are never a wider surface than the ingest API.

## Deploy (Alchemy, from the repo root)

The Worker and its D1 store are defined in `alchemy.run.ts`
(ADR 0003); deploys run plan → apply and D1 migrations in
`worker/migrations/` are applied in order on every deploy. State lives in
`.alchemy/` (gitignored) locally.

- Routine prod deploy (needs `TELEMETRY_INGEST_TOKEN` in the environment —
  the same value baked into the package, so the secret reconciles
  unchanged): `pnpm worker:deploy`
- Local dev Worker (workerd + local D1 simulator, hot reload):
  `pnpm worker:dev`
- Tail prod logs (replaces `wrangler tail`): `pnpm worker:tail`
- Tear down a stage: `pnpm worker:destroy`

### First prod run only — adopt the existing resources

The live Worker and database predate Alchemy, so the first prod deploy must
take them over:

```sh
TELEMETRY_INGEST_TOKEN=<current token> \
  pnpm exec alchemy deploy --stage prod --adopt
```

`--adopt` is needed once, until Alchemy's state records ownership.

### Escape hatch

`worker/wrangler.jsonc` still works for a script-only deploy
(`npx wrangler deploy` from this directory). Schema changes do **not** flow
through wrangler anymore — `schema.sql` moved to
`worker/migrations/0001_init.sql` and is applied by Alchemy deploys.
Durable Object class changes are the one thing wrangler needs spelled out
that Alchemy derives itself: new agent classes must be added to both
`durable_objects.bindings` and the `migrations` `new_sqlite_classes` list
in `wrangler.jsonc` to keep the escape hatch deployable (ADR 0003).

## Legacy manual runbook (superseded by the above)

1. `npx wrangler d1 create workbench-telemetry` — put the returned
   `database_id` into `wrangler.jsonc`.
2. `npx wrangler d1 execute workbench-telemetry --remote --file migrations/0001_init.sql`
3. `npx wrangler secret put TELEMETRY_INGEST_TOKEN` — generate a long
   random value; the same value is baked into the package by the
   Telemetry collector.
4. `npx wrangler deploy`

Verify with `curl https://workbench-telemetry.<account>.workers.dev/healthz`.

The endpoint URL and token become the client-side constants when the
Telemetry collector (#14) lands.
