import { deepStrictEqual } from "node:assert";
import test from "node:test";

import { forbiddenTarballEntries, shippedConfigViolations } from "./pack-smoke.mjs";

test("flags worker test resources riding in the tarball", () => {
  deepStrictEqual(forbiddenTarballEntries(["package/worker/runtime.test.mjs"]), [
    "package/worker/runtime.test.mjs",
  ]);
  deepStrictEqual(forbiddenTarballEntries(["package/vite.worker.config.ts"]), [
    "package/vite.worker.config.ts",
  ]);
});

test("packaged runtime files are allowed", () => {
  deepStrictEqual(
    forbiddenTarballEntries([
      "package/vite.config.ts",
      "package/bin.mjs",
      "package/src/data.generated.ts",
    ]),
    [],
  );
});

test("flags dev-only references in the shipped vite config", () => {
  deepStrictEqual(
    shippedConfigViolations(
      'import { cloudflareTest } from "@cloudflare/vitest-pool-workers";\nreadD1Migrations("./worker/migrations")',
    ),
    ["@cloudflare/vitest-pool-workers", "worker/migrations"],
  );
  deepStrictEqual(shippedConfigViolations('import react from "@vitejs/plugin-react";'), []);
});
