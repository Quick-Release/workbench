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

// The worker suite runs as two workerd projects that differ only in the
// agent's tick interval (#261). The default project leaves
// DIGEST_TICK_INTERVAL_SECONDS unset, so the agent ticks at the production
// daily default and no real tick fires between a test's requests. The tick
// project sets it to one second: the SDK scheduler only fires rows past their
// scheduled time, and the one-second interval makes a forced alarm
// deterministically find the tick due. At that interval a real tick also
// fires on its own within a second of arming, so only tick-driven tests
// (*.tick.runtime.test.mjs) run there.
const TICK_TESTS = "worker/*.tick.runtime.test.mjs";

const workerProject = (
  name: string,
  bindings: Record<string, string>,
  test: { include: string[]; exclude?: string[] },
) => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./worker/wrangler.jsonc" },
      miniflare: {
        bindings: {
          TELEMETRY_INGEST_TOKEN: "test-ingest-token",
          TEST_MIGRATIONS: workerD1Migrations,
          ...bindings,
        },
      },
    }),
  ],
  test: { name, pool: "@cloudflare/vitest-pool-workers", ...test },
});

export default defineConfig({
  test: {
    projects: [
      workerProject(
        "worker",
        {},
        {
          include: ["worker/runtime.test.mjs", "worker/*.runtime.test.mjs"],
          exclude: [TICK_TESTS],
        },
      ),
      workerProject(
        "worker-tick",
        { DIGEST_TICK_INTERVAL_SECONDS: "1" },
        { include: [TICK_TESTS] },
      ),
    ],
  },
});
