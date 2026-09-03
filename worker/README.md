# Workbench ingest endpoint

The company-owned Cloudflare Worker + D1 store behind workbench Telemetry
and Content sourcing submissions (ADR 0001). The handler is a pure fetch
function (`worker.mjs`) — the tests drive it directly with an in-memory
D1 double, no runtime needed.

## Routes

- `POST /telemetry` — one payload per Developer per host repo per UTC day;
  duplicates (same day, repo, identity) answer `409`.
- `POST /submissions` — one Developer-submitted commit message; duplicates
  (same repo, sha) answer `409`; rows land with `status = 'pending'` for
  marketing review.
- `GET /healthz` — liveness, no auth.

Both POST routes require `Authorization: Bearer <token>`; the token is the
shared ingest secret (set as the `TELEMETRY_INGEST_TOKEN` secret here and
baked into the workbench package, whose GitHub Packages registry is the
company boundary).

## One-time deploy

From this directory:

1. `npx wrangler d1 create workbench-telemetry` — put the returned
   `database_id` into `wrangler.jsonc`.
2. `npx wrangler d1 execute workbench-telemetry --remote --file schema.sql`
3. `npx wrangler secret put TELEMETRY_INGEST_TOKEN` — generate a long
   random value; the same value is baked into the package by the
   Telemetry collector.
4. `npx wrangler deploy`

Verify with `curl https://workbench-telemetry.<account>.workers.dev/healthz`.

The endpoint URL and token become the client-side constants when the
Telemetry collector (#14) lands.
