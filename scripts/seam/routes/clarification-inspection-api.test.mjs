import { deepStrictEqual, ok, strictEqual } from "node:assert";
import test from "node:test";

import { handleClarificationApi, isClarificationApiRoute } from "./clarification-api.mjs";

// The inspection routes (spec #221, ticket #237): the run list the In
// flight chips read, the inspection read behind the panel-per-axis status,
// and the run actions of the action matrix — tested like the other
// clarification routes, pure handlers over a fake coordinator: schema
// round-trips, the request gate, posture denials, method mismatches, and
// typed rejections keeping their statuses.

const loopback = { host: "localhost:4051", origin: "http://localhost:4051" };
const enabled = { posture: "enabled", available: false };
const disabled = { posture: "disabled", available: false };

const runRow = {
  runId: "run_1",
  hostRepo: "example/project",
  issueId: "230",
  requestId: "start-1",
  state: "awaiting-human",
  createdAt: "2026-09-18T10:00:00.000Z",
  updatedAt: "2026-09-18T10:00:05.000Z",
};

const inspectionView = {
  runId: "run_1",
  lease: {
    owner: "workbench-clarification-coordinator",
    generation: 2,
    acquiredAt: "2026-09-18T10:00:00.000Z",
    expiresAt: "2026-09-18T10:00:30.000Z",
    expired: true,
  },
  usage: {
    lines: [
      {
        lineId: "usage_1",
        kind: "unknown",
        unit: "subscription",
        value: null,
        createdAt: "2026-09-18T10:00:02.000Z",
      },
    ],
    totals: { reported: {}, estimated: {}, unknownLines: 1 },
  },
  escalations: [],
  readiness: {
    axes: [
      { axis: "tracker-eligibility", verdict: "unknown", reasons: ["tracker down"] },
      { axis: "brief-completeness", verdict: "needs-information", reasons: ["no draft"] },
      { axis: "host-capability", verdict: "ready", reasons: [] },
      { axis: "research-sufficiency", verdict: "needs-information", reasons: [] },
      { axis: "authorization", verdict: "ready", reasons: [] },
    ],
  },
};

const fakeCoordinator = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    listRunStates: () => {
      calls.push(["listRunStates"]);
      return {
        runs: [
          {
            runId: "run_1",
            issueId: "230",
            state: "awaiting-human",
            updatedAt: runRow.updatedAt,
          },
        ],
      };
    },
    inspection: async (args) => {
      calls.push(["inspection", args]);
      return inspectionView;
    },
    runAction: async (args) => {
      calls.push(["runAction", args]);
      return { kind: args.action.kind, done: true, requestId: args.requestId, run: runRow };
    },
    ...overrides,
  };
};

const request = (overrides) => ({ ...loopback, posture: enabled, ...overrides });

test("the inspection routes are clarification routes", () => {
  ok(isClarificationApiRoute("/api/clarification/runs"));
  ok(isClarificationApiRoute("/api/clarification/runs/run_1/inspection"));
  ok(isClarificationApiRoute("/api/clarification/runs/run_1/actions"));
});

test("the run list round-trips the schema and is posture-free", async () => {
  const coordinator = fakeCoordinator();
  const answer = await handleClarificationApi(
    request({ method: "GET", pathname: "/api/clarification/runs", posture: disabled, coordinator }),
  );
  strictEqual(answer.status, 200);
  deepStrictEqual(answer.json.runs[0], {
    runId: "run_1",
    issueId: "230",
    state: "awaiting-human",
    updatedAt: runRow.updatedAt,
  });
});

test("the run list answers 501 without a coordinator and refuses foreign origins", async () => {
  const unwired = await handleClarificationApi(
    request({ method: "GET", pathname: "/api/clarification/runs", coordinator: null }),
  );
  strictEqual(unwired.status, 501);
  const foreign = await handleClarificationApi({
    method: "GET",
    pathname: "/api/clarification/runs",
    host: "localhost:4051",
    origin: "https://evil.example",
    coordinator: fakeCoordinator(),
  });
  strictEqual(foreign.status, 403);
});

test("the inspection read passes the posture through and parses the view", async () => {
  const coordinator = fakeCoordinator();
  const answer = await handleClarificationApi(
    request({
      method: "GET",
      pathname: "/api/clarification/runs/run_1/inspection",
      coordinator,
    }),
  );
  strictEqual(answer.status, 200);
  deepStrictEqual(answer.json, inspectionView);
  deepStrictEqual(coordinator.calls, [["inspection", { runId: "run_1", posture: enabled }]]);
});

test("an inspection view carrying a lease token fails the wire contract", async () => {
  const coordinator = fakeCoordinator({
    inspection: async () => ({
      ...inspectionView,
      lease: { ...inspectionView.lease, token: "lease_secret" },
    }),
  });
  const answer = await handleClarificationApi(
    request({ method: "GET", pathname: "/api/clarification/runs/run_1/inspection", coordinator }),
  );
  strictEqual(answer.status, 500);
});

test("the inspection read speaks GET only, and an unknown run is a 404", async () => {
  const wrong = await handleClarificationApi(
    request({
      method: "POST",
      pathname: "/api/clarification/runs/run_1/inspection",
      coordinator: fakeCoordinator(),
    }),
  );
  strictEqual(wrong.status, 405);
  const missing = await handleClarificationApi(
    request({
      method: "GET",
      pathname: "/api/clarification/runs/run_x/inspection",
      coordinator: fakeCoordinator({
        inspection: async () => {
          throw Object.assign(new Error("no run"), { code: "run_not_found" });
        },
      }),
    }),
  );
  strictEqual(missing.status, 404);
});

const action = (body, overrides = {}) =>
  request({
    method: "POST",
    pathname: "/api/clarification/runs/run_1/actions",
    body: JSON.stringify(body),
    coordinator: fakeCoordinator(),
    ...overrides,
  });

test("each run action travels typed to the coordinator and its answer parses", async () => {
  for (const actionBody of [
    { kind: "cancel-attempt", attemptId: "attempt_1" },
    { kind: "retain-evidence" },
    { kind: "discard-evidence", confirmation: "run_1" },
    {
      kind: "retry",
      revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
    },
  ]) {
    const coordinator = fakeCoordinator();
    const answer = await handleClarificationApi(
      action({ requestId: "r-1", action: actionBody }, { coordinator }),
    );
    strictEqual(answer.status, 200, actionBody.kind);
    strictEqual(answer.json.kind, actionBody.kind);
    deepStrictEqual(coordinator.calls, [
      ["runAction", { runId: "run_1", requestId: "r-1", action: actionBody }],
    ]);
  }
});

test("a disabled install denies run actions before the body is read", async () => {
  const coordinator = fakeCoordinator();
  const answer = await handleClarificationApi(
    action({ nonsense: true }, { posture: disabled, coordinator }),
  );
  strictEqual(answer.status, 403);
  strictEqual(answer.json.error, "clarification_disabled");
  deepStrictEqual(coordinator.calls, []);
});

test("a malformed run action is a named 400, never a coordinator call", async () => {
  for (const body of [
    { requestId: "", action: { kind: "retain-evidence" } },
    { requestId: "r", action: { kind: "delete-everything" } },
    { requestId: "r", action: { kind: "discard-evidence" } },
    { requestId: "r", action: { kind: "retry" } },
  ]) {
    const coordinator = fakeCoordinator();
    const answer = await handleClarificationApi(action(body, { coordinator }));
    strictEqual(answer.status, 400, JSON.stringify(body));
    deepStrictEqual(coordinator.calls, []);
  }
});

test("run action rejections keep their typed statuses", async () => {
  const cases = [
    ["discard_unconfirmed", 400],
    ["illegal_transition", 409],
    ["run_not_active", 409],
    ["attempt_not_active", 409],
    ["manifest_stale", 409],
    ["busy", 409],
    ["run_not_found", 404],
    ["publication_uncertain", 409],
    ["dispatch_unrecorded", 502],
  ];
  for (const [code, statusCode] of cases) {
    const answer = await handleClarificationApi(
      action(
        { requestId: "r", action: { kind: "retain-evidence" } },
        {
          coordinator: fakeCoordinator({
            runAction: async () => {
              throw Object.assign(new Error(code), { code });
            },
          }),
        },
      ),
    );
    strictEqual(answer.status, statusCode, code);
    strictEqual(answer.json.error, code);
  }
});

test("the run actions route speaks POST only", async () => {
  const answer = await handleClarificationApi(
    request({
      method: "GET",
      pathname: "/api/clarification/runs/run_1/actions",
      coordinator: fakeCoordinator(),
    }),
  );
  strictEqual(answer.status, 405);
});
