import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

// Test-only configuration for the worker suite (ticket #29): never shipped in
// the package (`files` excludes it) and never loaded by `vp dev`/`vp build` —
// the installed CLI's startup must not depend on this devDependency or on
// worker/ resources (ticket #113). Run it explicitly:
//   vp test run --config vite.worker.config.ts
//
// cloudflareTest resolves the worker entry and bindings from
// worker/wrangler.jsonc — the escape-hatch config a bare `wrangler deploy`
// uses (ADR 0003 keeps alchemy as the deploy surface, so the two must be kept
// equivalent by hand). The test config carries no TELEMETRY_INGEST_TOKEN
// binding from the environment (alchemy injects that secret at deploy), so
// authenticated-path runtime tests supply it themselves as a Miniflare
// plain-text binding — a throwaway fixture, never a real secret.
//
// The worker suite's D1 starts empty; the migration SQL is handed in as a
// plain binding and applied by the tests that need the tables (the
// documented applyD1Migrations pattern of the vitest-pool-workers plugin).
const workerD1Migrations = await readD1Migrations(
  fileURLToPath(new URL("./worker/migrations", import.meta.url)),
);

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./worker/wrangler.jsonc" },
            miniflare: {
              bindings: {
                TELEMETRY_INGEST_TOKEN: "test-ingest-token",
                TEST_MIGRATIONS: workerD1Migrations,
                // The agent's daily tick runs on the SDK scheduler, which
                // only fires rows past their scheduled time; the one-second
                // interval makes a forced alarm deterministically find it
                // due (production defaults to 86,400 seconds).
                DIGEST_TICK_INTERVAL_SECONDS: "1",
              },
            },
          }),
        ],
        test: {
          include: ["worker/runtime.test.mjs", "worker/*.runtime.test.mjs"],
          pool: "@cloudflare/vitest-pool-workers",
        },
      },
    ],
  },
});
