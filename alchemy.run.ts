// Workbench infrastructure as code (ADR 0003): the telemetry ingest Worker
// and its D1 store. This file is the deploy surface; `worker/wrangler.jsonc`
// stays as the escape hatch for a bare `wrangler deploy` of the script.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// worker/wrangler.jsonc `d1_databases[0]` — binding D1_DB, database
// workbench-telemetry. Migrations apply in order on every deploy; the live
// database (migrated by hand via `wrangler d1 execute`) is taken over with
// a one-time `--adopt` on the first `pnpm worker:deploy`.
export const TelemetryDatabase = Cloudflare.D1.Database("workbench-telemetry", {
  migrations: "./worker/migrations",
});

// worker/wrangler.jsonc `name`/`main` — async mode: worker.mjs stays a
// plain fetch handler; its env type is derived from these bindings.
export const TelemetryWorker = Cloudflare.Worker("workbench-telemetry", {
  main: "./worker/worker.mjs",
  // nodejs_compat is required by the Agents SDK (ticket #31); the flag is
  // mirrored in worker/wrangler.jsonc to keep the escape hatch equivalent.
  compatibility: { date: "2026-08-01", flags: ["nodejs_compat"] },
  env: {
    D1_DB: TelemetryDatabase,
    // Config.redacted binds as secret_text; the value is read from the
    // TELEMETRY_INGEST_TOKEN environment variable at deploy time.
    TELEMETRY_INGEST_TOKEN: Config.redacted("TELEMETRY_INGEST_TOKEN"),
    // worker/wrangler.jsonc `durable_objects.bindings[0]` — the class is
    // exported by worker.mjs itself, and alchemy derives the SQLite-class
    // migration for new DO classes, so no manual migration block is needed
    // on this deploy path (ADR 0003).
    SubmissionReviewAgent: Cloudflare.DurableObject("SubmissionReviewAgent"),
  },
});

export default Alchemy.Stack(
  "workbench",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* TelemetryWorker;
    return { url: worker.url };
  }),
);
