import { deepStrictEqual } from "node:assert";
import test from "node:test";

import {
  clarificationContractFailures,
  forbiddenTarballEntries,
  missingCapabilityEntries,
  shippedConfigViolations,
} from "./pack-smoke.mjs";

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

test("flags a tarball that dropped part of the clarification capability", () => {
  deepStrictEqual(
    missingCapabilityEntries([
      "package/scripts/seam/routes/clarification-api.mjs",
      "package/scripts/host/config.mjs",
      "package/src/schema.ts",
    ]),
    [
      "package/scripts/seam/clarification/posture.mjs",
      "package/scripts/seam/clarification/context-packet.mjs",
      "package/scripts/seam/clarification/coordinator.mjs",
      "package/scripts/seam/clarification/pi-managed.mjs",
      "package/scripts/seam/clarification/store.mjs",
    ],
  );
});

test("a tarball carrying the clarification capability is complete", () => {
  deepStrictEqual(
    missingCapabilityEntries([
      "package/scripts/seam/routes/clarification-api.mjs",
      "package/scripts/seam/clarification/posture.mjs",
      "package/scripts/seam/clarification/context-packet.mjs",
      "package/scripts/seam/clarification/coordinator.mjs",
      "package/scripts/seam/clarification/pi-managed.mjs",
      "package/scripts/seam/clarification/store.mjs",
      "package/scripts/host/config.mjs",
      "package/src/schema.ts",
    ]),
    [],
  );
});

// The installed-boot contract, held to the same shapes the unit tier
// (scripts/seam/routes/clarification-api.test.mjs) holds the seam to.

test("a dormant install answers its status with the typed disabled posture", () => {
  deepStrictEqual(
    clarificationContractFailures("dormant-status", {
      status: 200,
      json: { posture: "disabled", available: false },
    }),
    [],
  );
});

test("a dormant status drift is named, key by key", () => {
  const failures = clarificationContractFailures("dormant-status", {
    status: 200,
    json: { posture: "enabled", available: true, message: "sure, come on in" },
  });
  deepStrictEqual(failures, [
    'dormant-status: posture must be "disabled", got "enabled"',
    "dormant-status: available must be false, got true",
    'dormant-status: must carry no message, got "sure, come on in"',
  ]);
});

test("a dormant start denial is the typed policy denial", () => {
  deepStrictEqual(
    clarificationContractFailures("dormant-start", {
      status: 403,
      json: {
        error: "clarification_disabled",
        message:
          "owned clarification is not enabled on this install — the clarification block in workbench.config.json opts an internal install in",
      },
    }),
    [],
  );
});

test("a drifted start denial names the drift", () => {
  deepStrictEqual(
    clarificationContractFailures("dormant-start", {
      status: 400,
      json: { error: "bad_request", message: "invalid JSON" },
    }),
    [
      "dormant-start: status must be 403, got 400",
      'dormant-start: error must be "clarification_disabled", got "bad_request"',
      'dormant-start: message must name the disabled posture, got "invalid JSON"',
    ],
  );
});

test("a probe whose body never parsed is a failure, not a crash", () => {
  deepStrictEqual(
    clarificationContractFailures("dormant-status", { status: 200, json: undefined }),
    ["dormant-status: response body was not JSON"],
  );
});

test("an unknown probe phase is a programmer error", () => {
  deepStrictEqual(clarificationContractFailures("mystery", { status: 200, json: {} }), [
    "mystery: unknown probe phase",
  ]);
});

const INVALID_REASONS = [
  "clarification.provider is required when clarification is enabled",
  "clarification.dataDestination is required when clarification is enabled",
];

test("an invalid posture answers its status naming the offending elements", () => {
  deepStrictEqual(
    clarificationContractFailures("invalid-status", {
      status: 200,
      json: { posture: "invalid", available: false, reasons: INVALID_REASONS },
    }),
    [],
  );
});

test("a drifted invalid status names the drift, reasons included", () => {
  deepStrictEqual(
    clarificationContractFailures("invalid-status", {
      status: 200,
      json: { posture: "invalid", available: false, reasons: ["something else"] },
    }),
    [
      'invalid-status: posture reasons must be the two missing-element reasons, got ["something else"]',
    ],
  );
});

test("an invalid start denial is the typed posture rejection", () => {
  deepStrictEqual(
    clarificationContractFailures("invalid-start", {
      status: 403,
      json: {
        error: "clarification_posture_invalid",
        reasons: INVALID_REASONS,
        message: `the clarification configuration is incomplete: ${INVALID_REASONS.join("; ")}`,
      },
    }),
    [],
  );
});

test("a start denial without the reasons is a drift", () => {
  deepStrictEqual(
    clarificationContractFailures("invalid-start", {
      status: 403,
      json: { error: "clarification_posture_invalid", message: "no reasons given" },
    }),
    [
      "invalid-start: denial reasons must be the two missing-element reasons, got undefined",
      'invalid-start: message must name the offending elements, got "no reasons given"',
    ],
  );
});
