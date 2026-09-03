# Adopting Alchemy in @quick-release/workbench

**Date:** 2026-09-03
**Sources:** primary only — alchemy.run docs (fetched live: what-is-alchemy, getting-started, migrating-from-v1, CLI pages, environments pages, state-store, Cloudflare provider pages), the [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy) GitHub repo (README, releases, API), the npm registry (`npm view alchemy`, queried live on this date), and Cloudflare docs for the current wrangler D1-migration model.

## TL;DR

**Verdict:** stay on wrangler for now. Alchemy is a genuinely good fit for the shape of this repo's infrastructure — one Worker + one D1 is its core Cloudflare demo case, and its async-Worker mode adopts `worker.mjs` unchanged — but today (2026-09-03) `alchemy` is a 2.0.0 **beta** whose own README says "alchemy is in alpha. Expect breaking changes", and it peer-depends on **Effect v4-RC**, while this repo deliberately pins `effect` 3.22.1 (see [effect-adoption.md](./effect-adoption.md)). For an internal tool with a documented four-command manual deploy and zero CI deploy today, the payoff (per-dev stages, PR previews, typed bindings, plan/apply drift correction) does not cover that risk. Revisit when 2.0 goes stable or when the ingest stack grows a second environment/service.

**Recommended first step:** none now. Set a re-check trigger: when `alchemy@2` publishes a stable (non-beta) `latest`, prototype an `alchemy.run.ts` in a scratch stage against the live resources with `alchemy deploy --adopt` — `worker/wrangler.jsonc` stays in the repo untouched as the escape hatch throughout.

---

## 1. What Alchemy is

Alchemy calls itself an "Infrastructure-as-Effects framework": it "extends Infrastructure-as-Code by combining your cloud resources and the application logic that uses them into a single, type-safe program powered by Effect" ([what-is-alchemy](https://alchemy.run/what-is-alchemy)). npm describes the package as "Infrastructure as Effects for TypeScript" with a single `alchemy` CLI bin (npm, queried live 2026-09-03). Against Terraform/Pulumi/CDK, Alchemy's own positioning is that "traditional IaC tools like Terraform, Pulumi, and CDK separate infrastructure definitions from application code… then wire them together with environment variables, ARNs, and config files", whereas in Alchemy "infrastructure and logic are Effects in the same program" ([what-is-alchemy](https://alchemy.run/what-is-alchemy)). Against this repo's `wrangler.jsonc` deploy, the difference is that bindings are "declared where it's used — deploying the Worker deploys the wiring", instead of a config file the code must silently agree with ([Workers](https://alchemy.run/cloudflare/compute/workers)); the engine runs a plan → apply loop over providers implementing read/diff/reconcile/delete ([what-is-alchemy](https://alchemy.run/what-is-alchemy)). The Cloudflare ecosystem is a first-class target: "one Worker runtime plus resources like Durable Objects, D1, R2, Queues, and Hyperdrive, wired together by typed bindings" ([Cloudflare hub](https://alchemy.run/cloudflare)). Notably for this repo, Alchemy 2.0 is itself built on Effect ("Infrastructure as Effects"), the same library [effect-adoption.md](./effect-adoption.md) evaluates for the app code.

## 2. Project state (verified via npm + GitHub, 2026-09-03)

| Package                           | Version / dist-tag                                 | Note                                                                                               |
| --------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `alchemy`                         | **2.0.0-beta.76** (`latest`, published 2026-08-31) | unscoped; CLI bin `alchemy`; Apache-2.0; no `engines` field (npm, queried live)                    |
| `alchemy` `next`                  | 2.0.0-beta.72                                      | second dist-tag (npm)                                                                              |
| `@alchemy.run/cloudflare-runtime` | 2.0.0-beta.76                                      | Worker-runtime companion; a **dependency** of `alchemy`, not installed directly (npm dependencies) |

- **No 1.x line exists**: npm's 369 published versions run 0.0.2 → 0.94.0, then straight to `2.0.0-beta.*` (npm version list, queried live). The v1 docs survive at v1.alchemy.run and v2 is a rewrite on Effect generators ([migrating from v1](https://alchemy.run/migrating-from-v1)) — blog posts about "v1 Alchemy" describe a different API.
- **Maturity:** README states "alchemy is in alpha. Expect breaking changes" ([README](https://github.com/alchemy-run/alchemy/blob/main/README.md)). Cadence is high: five GitHub releases (beta.72 → beta.76) between 2026-08-12 and 2026-08-31; repo last pushed 2026-09-03; ~1.2k stars, Apache-2.0, 194 open issues (GitHub API, queried live).
- **Runtime requirements:** "Bun (recommended) or Node.js 22+" ([getting started](https://alchemy.run/getting-started)); no `engines` restriction on the package. This repo's Node 24 CI (`release.yml`) and Node 22+ local dev are fine. **TypeScript:** no TS minimum is documented anywhere on alchemy.run (checked 2026-09-03 — explicitly unverified); Effect v4's documented minimum is TS ≥ 5.9 (see [effect-adoption.md](./effect-adoption.md) §2), which this repo's TS 6.0.3 + `strict` satisfies.
- **The real blocker:** `alchemy@2.0.0-beta.76` declares `"effect": ">=4.0.0-rc.112 || >=4.0.0"` as a **peerDependency** (npm, queried live), and the documented install is `pnpm add "alchemy@latest" "effect@rc" ...` ([getting started](https://alchemy.run/getting-started)). This repo pins `effect` **3.22.1** (`package.json`) and [effect-adoption.md](./effect-adoption.md) recommends staying on v3. Adopting Alchemy today means moving the root `effect` to the v4 RC — the two adoption notes collide.

## 3. Mapping this repo's infrastructure to Alchemy resources

`worker/wrangler.jsonc` defines exactly: Worker `workbench-telemetry` (main `worker.mjs`, `compatibility_date` 2026-08-01) and one D1 database (`binding: "D1_DB"`, `database_name: "workbench-telemetry"`, id placeholder), plus the `TELEMETRY_INGEST_TOKEN` secret set out-of-band via `wrangler secret put` ([worker/README.md](../../worker/README.md)). No cron triggers, routes, or env blocks exist, so there is nothing else to map. In Alchemy terms ([D1](https://alchemy.run/cloudflare/data/d1), [Workers](https://alchemy.run/cloudflare/compute/workers)):

```ts
// alchemy.run.ts (repo root) — replaces worker/wrangler.jsonc as the deploy surface
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// worker/wrangler.jsonc "d1_databases[0]" (binding D1_DB, db workbench-telemetry)
export const Database = Cloudflare.D1.Database("workbench-telemetry", {
  migrations: "./worker/migrations", // schema.sql copied to 0001_init.sql (see below)
});

// worker/wrangler.jsonc "name"/"main" — async style: worker.mjs is unchanged
export const Worker = Cloudflare.Worker("workbench-telemetry", {
  main: "./worker/worker.mjs",
  env: {
    D1_DB: Database, // InferEnv types this as the native D1Database workers-type
    TELEMETRY_INGEST_TOKEN: Config.redacted("TELEMETRY_INGEST_TOKEN"), // bound as secret_text
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "workbench",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url }; // workers.dev subdomain enabled, URL as stack output
  }),
);
```

```sh
pnpm alchemy deploy --stage prod   # first prod run adds --adopt to take over the wrangler-created Worker + D1
pnpm alchemy dev                   # workerd + local D1 simulator, hot reload (section 4)
pnpm alchemy tail --stage prod     # replaces `wrangler tail`
pnpm alchemy destroy --stage prod  # plan + confirm + delete everything in the stage
```

The key fit is the **async Worker style**: "a Worker doesn't have to be an Effect program. When `main` points at a plain module — a classic async fetch handler… declare bindings with the `env` prop and derive the runtime type with `InferEnv`", where "a D1 database becomes `D1Database`… The handler stays plain JavaScript but the env can never drift from the infrastructure that produced it" ([Workers](https://alchemy.run/cloudflare/compute/workers)). `worker.mjs`'s `env.D1_DB.prepare(...).bind(...).run()` keeps working untouched; secrets bind as `secret_text` ([Secrets & env](https://alchemy.run/cloudflare/security/secrets-env)).

**D1 schema/migrations vs today.** Today the schema is applied once by hand: `npx wrangler d1 execute workbench-telemetry --remote --file schema.sql` ([worker/README.md](../../worker/README.md)) — Cloudflare's own versioning model would be `wrangler d1 migrations` with a `migrations/` folder and a `d1_migrations` bookkeeping table ([Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)). Alchemy's model: point `migrations` at "a folder of `.sql` files… sorted by numeric prefix (0001_, 0002_, …) and applied in order as part of every deploy; already-applied migrations are skipped", with bookkeeping in Alchemy's `__alchemy_migrations` table; databases previously migrated with `wrangler d1 migrations apply` are adopted automatically, and "D1 has no transactions over HTTP, so each migration and its bookkeeping row are sent as one batched query, matching wrangler's own behavior" ([D1](https://alchemy.run/cloudflare/data/d1)). Because this repo never used `wrangler d1 migrations` (plain `execute --file`) and `schema.sql` is fully idempotent (`CREATE TABLE IF NOT EXISTS` throughout), the migration is trivial: copy `worker/schema.sql` → `worker/migrations/0001_init.sql`; replaying it against the live database is a no-op. One unverified detail: the exact prop carrying `compatibility_date: "2026-08-01"` — Alchemy's Workers page says a Worker carries "name, bundle, compatibility flags", but I did not find the prop name documented on the pages fetched.

**Taking over the live resources.** The Worker and D1 database already exist outside any Alchemy state. A resource the provider can't prove ownership of fails deploy with `OwnedBySomeoneElse` unless you pass `alchemy deploy --adopt` ("take over" path) ([Adopting Resources](https://alchemy.run/cli/adopting-resources)).

## 4. Local dev and test interplay

Alchemy stages are isolated deploy instances with their own state and physical names; the default stage is `dev_$USER` (resolution: `--stage` > `$STAGE` > `dev_${USER}`) ([Stages](https://alchemy.run/environments/stages)). `alchemy dev` runs Workers locally in workerd with local simulators for "KV, R2, D1, Queues, Hyperdrive" (ids prefixed `dev:` as proof no cloud call ran), hot-reloads code in milliseconds, and `Alchemy.remote()` pins a resource live-on-demand; non-emulatable resources deploy to your personal stage ([Local development](https://alchemy.run/environments/local-development)). Vite dev servers can join the same loop via `Command.Dev`: "arbitrary dev processes — Vite, Next, anything with a dev server — started by `alchemy dev`, restarted when its inputs change, and a no-op on deploy" ([Local development](https://alchemy.run/environments/local-development)).

For this repo the change is **additive, not a replacement**: there is no `wrangler dev` workflow today — `pnpm dev` runs only the Vite SPA (`package.json`), and the Worker tests bypass runtimes entirely by driving `worker.mjs`'s fetch handler against a `node:sqlite` D1 double (`worker/worker.test.mjs`). That pattern is untouched by Alchemy; Alchemy's own test harness (Bun/Vitest adapters, `Test.make({ dev: true })` against local emulators) would only matter if we wanted deploy-based integration tests ([Testing](https://alchemy.run/testing)).

## 5. CI/CD and secrets

Alchemy's CI model is "credentials as code": a one-time `stacks/github.ts` stack, deployed locally under an admin profile, mints a scoped `Cloudflare.ApiToken.AccountApiToken` (permission groups including "D1 Write", "Workers Tail Read", "Secrets Store Write") and writes it into the repo as `GitHub.Secret`s; the workflow then runs `alchemy deploy --stage $STAGE` where `STAGE` is `prod` on main and `pr-{number}` per PR, with a cleanup job running `alchemy destroy --stage pr-{n}` guarded by a prod-safety check ([CI](https://alchemy.run/environments/ci)). State for CI lives in the **remote Cloudflare state store**: `Cloudflare.state()` deploys an `alchemy-state-store` Worker (Durable Object with embedded SQLite), encrypts resource state at rest with a key held in your account's Secrets Store, and "on CI, set `CI=true`; the credentials are resolved from the Secrets Store on every run via a short-lived edge-preview Worker, so nothing needs to be persisted to disk" — locally, state defaults to the gitignored `.alchemy/` directory ([State Store](https://alchemy.run/state-store)).

Compare with today: deploy is a manual, documented sequence (`d1 create` → `d1 execute` → `secret put` → `wrangler deploy`, [worker/README.md](../../worker/README.md)), and CI (`release.yml`) only publishes the npm package via changesets — no Worker deploy exists. Alchemy would introduce the repo's first CI deploy path; the simpler alternative is one `wrangler deploy` step in `release.yml`. On secrets: `TELEMETRY_INGEST_TOKEN` would come from the deploy-time environment via `Config.redacted` instead of interactive `wrangler secret put` — the value must stay identical to the copy baked into the published workbench package ([worker/README.md](../../worker/README.md)).

## 6. Risks, costs, and verdict

- **Pre-1.0 beta.** `latest` is a beta; the README says "expect breaking changes"; there is no stable 1.x or 2.x release yet (npm, 2026-09-03). Velocity is a double-edged signal: five releases in August 2026 and same-day pushes ([GitHub releases](https://github.com/alchemy-run/alchemy/releases)).
- **Effect version collision.** The `effect >=4.0.0-rc.112` peer dep forces the v4 RC into a repo pinned to v3 — the single largest concrete cost here, contradicting [effect-adoption.md](./effect-adoption.md)'s "pin v3" guidance.
- **State and lock-in.** State lives in Alchemy's own formats (local `.alchemy/` or its state-store Worker); nothing else reads it. But the managed objects are ordinary Cloudflare resources: `worker/wrangler.jsonc` keeps working as a fallback for script deploys, D1 data is unaffected by who applied the schema, `alchemy destroy --stage prod` removes a stage's resources ([destroy](https://alchemy.run/cli/destroy)), and `alchemy nuke` enumerates and deletes everything the stack's providers created ([nuke](https://alchemy.run/cli/nuke)). Residue after walking away: the `alchemy-state-store` Worker and its Secrets Store entries (manual deletion).
- **What breaks.** The manual runbook in [worker/README.md](../../worker/README.md) is superseded; `wrangler tail` becomes `alchemy tail`; migration bookkeeping moves from none/`d1_migrations` to `__alchemy_migrations`. Tests and the SPA are untouched.
- **Alternatives, briefly.** Plain wrangler (status quo): four documented commands, no drift detection, no per-developer isolation — but for one Worker + one D1 that rarely changes, that surface is nearly zero. Terraform: exactly the shape Alchemy's positioning argues against — "infrastructure definitions… in one place and business logic in another" ([what-is-alchemy](https://alchemy.run/what-is-alchemy)) — plus state management and a second language, with no Worker bundling integration, for a two-resource stack.

**Frank verdict for THIS repo:** stay on wrangler. This is an internal tool whose entire deployed surface is one Worker and one D1 database with a stable schema; the wrangler runbook is four commands written down in [worker/README.md](../../worker/README.md). Alchemy's strengths — `alchemy dev` with local D1, per-developer stages, PR previews, typed bindings, adoption of plain-JS handlers — pay off the moment this grows (a dashboard deploy target, a second Worker, CI-managed environments, more than one maintainer deploying). If adoption happens earlier than stable 2.0, adopt **narrowly**: `alchemy.run.ts` for the existing two resources with `--adopt`, wrangler.jsonc retained, and `effect@rc` isolated to the infra entry file until the app's own Effect decision follows.

## 7. Interaction with ADR 0001 (mandatory telemetry)

ADR 0001 makes Telemetry reporting mandatory with no opt-out (`docs/adr/0001-mandatory-telemetry-internal-tool.md`); the ingest endpoint is "a pure fetch handler: request + D1 binding in, response out" (`worker/worker.mjs`). Nothing in Alchemy's deploy model touches that contract — the async Worker keeps `worker.mjs` byte-for-byte, so the mandatory-reporting surface is unchanged. On Alchemy's own telemetry posture: runtime observability is OpenTelemetry export configured by an explicit Layer, and "without a telemetry layer, nothing exports — Effect's default tracer is a no-op, so all instrumentation stays free" ([Telemetry](https://alchemy.run/infrastructure-as-effects/telemetry)) — opt-in, so no conflict with a mandatory-reporting policy either way. None of the Alchemy pages fetched (CLI, state-store, CI, setup, getting-started) document any Alchemy CLI usage/telemetry reporting of its own; the state store and credential-resolution Workers run in your own Cloudflare account ([State Store](https://alchemy.run/state-store)) — that absence is a finding of absence, not a verified no-phone-home guarantee.

## Sources

- https://alchemy.run/what-is-alchemy (positioning, Terraform/Pulumi comparison, providers, two styles)
- https://alchemy.run/getting-started (prerequisites, install command, first deploy/profile flow)
- https://alchemy.run/migrating-from-v1 (v1 = async/await, v2 = Effect rewrite, v1.alchemy.run)
- https://alchemy.run/cloudflare (Cloudflare hub positioning)
- https://alchemy.run/cloudflare/compute/workers (Worker resource, async style, InferEnv, workers.dev URL)
- https://alchemy.run/cloudflare/data/d1 (D1 resource, migrations model, wrangler adoption, __alchemy_migrations)
- https://alchemy.run/cloudflare/security/secrets-env (Config.redacted → secret_text, async env prop)
- https://alchemy.run/environments/stages (default stage, isolation, resolution order)
- https://alchemy.run/environments/local-development (alchemy dev, workerd, simulators, Command.Dev)
- https://alchemy.run/environments/ci (credentials-as-code, deploy.yml, PR previews, token permission groups)
- https://alchemy.run/state-store (local .alchemy/, Cloudflare.state(), encryption, CI=true credential resolution)
- https://alchemy.run/cli/adopting-resources (--adopt, OwnedBySomeoneElse, recovery default)
- https://alchemy.run/cli/tail (tail vs wrangler tail), https://alchemy.run/cli/destroy, https://alchemy.run/cli/nuke (indexed at https://alchemy.run/llms.txt)
- https://alchemy.run/infrastructure-as-effects/telemetry (OTel export opt-in, no-op default)
- https://github.com/alchemy-run/alchemy (README "in alpha" notice, positioning) · [releases](https://github.com/alchemy-run/alchemy/releases) (beta cadence) · repo metadata + release list queried via GitHub API, 2026-09-03
- npm registry queried live via `npm view alchemy --json` / `npm view @alchemy.run/cloudflare-runtime dist-tags` / `npm view effect dist-tags` (versions, dist-tags, license, bin, peerDependencies, release timestamps), 2026-09-03
- https://developers.cloudflare.com/d1/reference/migrations/ (wrangler d1 migrations model, d1_migrations table)
- Repo files read: `package.json`, `pnpm-workspace.yaml`, `worker/wrangler.jsonc`, `worker/worker.mjs`, `worker/schema.sql`, `worker/worker.test.mjs`, `worker/README.md`, `.github/workflows/release.yml`, `CONTEXT.md`, `docs/adr/0001-mandatory-telemetry-internal-tool.md`
