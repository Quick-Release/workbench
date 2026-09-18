import { deepStrictEqual, match, strictEqual } from "node:assert";
import test from "node:test";

import {
  clarificationPostureLoader,
  handleClarificationApi,
  isClarificationApiRoute,
} from "./clarification-api.mjs";
import { noPublishingLine } from "../../../src/types.ts";

const loopback = { host: "localhost:4051", origin: "http://localhost:4051" };
const disabled = { posture: "disabled", available: false };
const invalid = {
  posture: "invalid",
  available: false,
  reasons: ["clarification.provider is required when clarification is enabled"],
};
const enabled = { posture: "enabled", available: false };

const status = (overrides = {}) => ({
  method: "GET",
  pathname: "/api/clarification",
  posture: disabled,
  coordinator: null,
  ...loopback,
  ...overrides,
});

const manifest = (overrides = {}) => ({
  method: "GET",
  pathname: "/api/clarification/manifest",
  query: new URLSearchParams("issue=230"),
  posture: disabled,
  coordinator: null,
  ...loopback,
  ...overrides,
});

const start = (overrides = {}) => ({
  method: "POST",
  pathname: "/api/clarification/start",
  body: JSON.stringify({
    issue: 230,
    requestId: "req-1",
    revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
  }),
  posture: disabled,
  coordinator: null,
  ...loopback,
  ...overrides,
});

const run = (overrides = {}) => ({
  method: "GET",
  pathname: "/api/clarification/run",
  query: new URLSearchParams("run=run_1"),
  posture: disabled,
  coordinator: null,
  ...loopback,
  ...overrides,
});

// The fake coordinator the handler tests run against: its answers are
// fixed typed results, its calls are recorded, and an unreachable command
// throws — so a test that expects a policy denial proves the denial came
// before the coordinator.
const fakeCoordinator = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    manifest: async ({ issueNumber }) => {
      calls.push(["manifest", { issueNumber }]);
      return {
        issue: {
          number: issueNumber,
          title: "Clarification 09",
          revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
        },
        provider: "openai-codex-oauth",
        dataDestination: "https://api.openai.com",
        capabilitySummary: ["reads the pinned issue"],
        egressStatement: "private content never enters public queries",
        budgetLine: "provider-reported usage is recorded verbatim",
        noPublishingLine,
      };
    },
    start: async (args) => {
      calls.push(["start", args]);
      return {
        started: true,
        run: {
          runId: "run_1",
          issueId: "230",
          state: "active",
          createdAt: "2026-09-18T10:00:01.000Z",
          updatedAt: "2026-09-18T10:00:01.000Z",
        },
        attempt: {
          attemptId: "attempt_1",
          state: "active",
          createdAt: "2026-09-18T10:00:03.000Z",
          updatedAt: "2026-09-18T10:00:03.000Z",
        },
      };
    },
    runSection: async (args) => {
      calls.push(["runSection", args]);
      return {
        run: {
          runId: "run_1",
          issueId: "230",
          state: "awaiting-human",
          createdAt: "2026-09-18T10:00:01.000Z",
          updatedAt: "2026-09-18T10:00:09.000Z",
        },
        attempts: [
          {
            attemptId: "attempt_1",
            state: "terminal",
            createdAt: "2026-09-18T10:00:03.000Z",
            updatedAt: "2026-09-18T10:00:04.000Z",
          },
        ],
        snapshot: { lifecycle: "awaiting-human" },
        snapshotSavedAt: "2026-09-18T10:00:09.000Z",
        events: [{ seq: 1, kind: "run.started", data: {}, createdAt: "2026-09-18T10:00:01.000Z" }],
      };
    },
    ...overrides,
  };
};

test("recognizes only the clarification routes", () => {
  strictEqual(isClarificationApiRoute("/api/clarification"), true);
  strictEqual(isClarificationApiRoute("/api/clarification/"), true);
  strictEqual(isClarificationApiRoute("/api/clarification/manifest"), true);
  strictEqual(isClarificationApiRoute("/api/clarification/start"), true);
  strictEqual(isClarificationApiRoute("/api/clarification/run"), true);
  strictEqual(isClarificationApiRoute("/api/clarification/other"), false);
  strictEqual(isClarificationApiRoute("/api/review"), false);
});

test("rejects a foreign host before answering any route", async () => {
  for (const request of [
    status({ host: "host-repo.example:4051" }),
    manifest({ host: "host-repo.example:4051" }),
    start({ host: "host-repo.example:4051" }),
    run({ host: "host-repo.example:4051" }),
  ]) {
    const handled = await handleClarificationApi(request);
    strictEqual(handled.status, 403);
    strictEqual(handled.json.error, "forbidden_host");
  }
});

test("rejects a cross-origin request before answering any route", async () => {
  for (const request of [
    status({ origin: "http://evil.example:4051" }),
    manifest({ origin: "http://evil.example:4051" }),
    start({ origin: "http://evil.example:4051" }),
    run({ origin: "http://evil.example:4051" }),
  ]) {
    const handled = await handleClarificationApi(request);
    strictEqual(handled.status, 403);
    strictEqual(handled.json.error, "cross_origin");
  }
});

test("answers nothing for routes it does not own", async () => {
  strictEqual(await handleClarificationApi(status({ pathname: "/api/workflow" })), null);
  strictEqual(await handleClarificationApi(start({ pathname: "/api/review" })), null);
});

test("answers the status route with the typed disabled posture", async () => {
  const handled = await handleClarificationApi(status());
  strictEqual(handled.status, 200);
  strictEqual(handled.json.posture, "disabled");
  strictEqual(handled.json.available, false);
  strictEqual(handled.json.reasons, undefined);
  strictEqual(handled.json.message, undefined);
});

test("the status route carries the invalid posture's reasons", async () => {
  const handled = await handleClarificationApi(status({ posture: invalid }));
  strictEqual(handled.status, 200);
  strictEqual(handled.json.posture, "invalid");
  deepStrictEqual(handled.json.reasons, invalid.reasons);
  strictEqual(handled.json.message, undefined);
});

test("the status route reports enabled as honestly unavailable", async () => {
  const handled = await handleClarificationApi(status({ posture: enabled }));
  strictEqual(handled.status, 200);
  strictEqual(handled.json.posture, "enabled");
  strictEqual(handled.json.available, false);
  match(handled.json.message, /managed conversation runtime is not wired/);
});

test("the status route answers GET only", async () => {
  const handled = await handleClarificationApi(status({ method: "POST", body: "{}" }));
  strictEqual(handled.status, 405);
  strictEqual(handled.json.error, "method_not_allowed");
});

test("the manifest route answers the fixed display contract on an enabled install", async () => {
  const coordinator = fakeCoordinator();
  const handled = await handleClarificationApi(manifest({ posture: enabled, coordinator }));
  strictEqual(handled.status, 200);
  // The success result crossed the Effect Schema — the display contract
  // holds, no-publishing line included, with no excess fields.
  strictEqual(handled.json.issue.number, 230);
  strictEqual(handled.json.noPublishingLine, "Publishing is NOT granted by this approval");
  deepStrictEqual(coordinator.calls, [["manifest", { issueNumber: 230 }]]);
});

test("the manifest route denies a disabled and an invalid posture before the coordinator", async () => {
  const coordinator = fakeCoordinator();
  const dormant = await handleClarificationApi(manifest({ posture: disabled, coordinator }));
  strictEqual(dormant.status, 403);
  strictEqual(dormant.json.error, "clarification_disabled");

  const misconfigured = await handleClarificationApi(manifest({ posture: invalid, coordinator }));
  strictEqual(misconfigured.status, 403);
  strictEqual(misconfigured.json.error, "clarification_posture_invalid");
  deepStrictEqual(misconfigured.json.reasons, invalid.reasons);
  deepStrictEqual(coordinator.calls, []);
});

test("the manifest route validates its issue query parameter", async () => {
  for (const query of ["", "issue=abc", "issue=0", "issue=-3", "issue=1.5"]) {
    const handled = await handleClarificationApi(
      manifest({
        posture: enabled,
        coordinator: fakeCoordinator(),
        query: new URLSearchParams(query),
      }),
    );
    strictEqual(handled.status, 400, `query "${query}" must be refused`);
    strictEqual(handled.json.error, "invalid_request");
  }
});

test("the manifest route answers GET only", async () => {
  const handled = await handleClarificationApi(
    manifest({ method: "POST", posture: enabled, coordinator: fakeCoordinator() }),
  );
  strictEqual(handled.status, 405);
  strictEqual(handled.json.error, "method_not_allowed");
});

test("start crosses schema validation and reaches the coordinator", async () => {
  const coordinator = fakeCoordinator();
  const handled = await handleClarificationApi(start({ posture: enabled, coordinator }));
  strictEqual(handled.status, 200);
  strictEqual(handled.json.started, true);
  strictEqual(handled.json.run.runId, "run_1");
  strictEqual(handled.json.attempt.attemptId, "attempt_1");
  deepStrictEqual(coordinator.calls, [
    [
      "start",
      {
        issueNumber: 230,
        requestId: "req-1",
        revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
      },
    ],
  ]);
});

test("start denies a disabled posture with a typed policy denial before reading the body", async () => {
  const coordinator = fakeCoordinator();
  const handled = await handleClarificationApi(start({ body: "not json", coordinator }));
  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "clarification_disabled");
  deepStrictEqual(coordinator.calls, []);
});

test("start denies an invalid posture naming the offending elements", async () => {
  const coordinator = fakeCoordinator();
  const handled = await handleClarificationApi(start({ posture: invalid, coordinator }));
  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "clarification_posture_invalid");
  deepStrictEqual(handled.json.reasons, invalid.reasons);
  deepStrictEqual(coordinator.calls, []);
});

test("start answers a malformed or non-conforming body with typed invalid requests", async () => {
  const coordinator = fakeCoordinator();
  const cases = [
    "not json",
    "{}",
    JSON.stringify({ issue: 230 }),
    JSON.stringify({ issue: 230, requestId: "req-1" }),
    JSON.stringify({ issue: 230, requestId: "req-1", revision: {}, extra: true }),
    JSON.stringify({
      issue: "230",
      requestId: "req-1",
      revision: { updatedAt: "u", bodyHash: "h" },
    }),
  ];
  for (const body of cases) {
    const handled = await handleClarificationApi(start({ posture: enabled, body, coordinator }));
    strictEqual(handled.status, 400, `body ${body} must be refused`);
    strictEqual(handled.json.error, "invalid_request");
  }
  deepStrictEqual(coordinator.calls, []);
});

test("duplicate, stale, reused, and unavailable starts are typed rejections with their own statuses", async () => {
  const cases = [
    ["busy", 409],
    ["manifest_stale", 409],
    ["request_reused", 409],
    ["context_unavailable", 503],
  ];
  for (const [code, expected] of cases) {
    const coordinator = fakeCoordinator({
      start: async () => {
        throw Object.assign(new Error(`typed ${code}`), { code });
      },
    });
    const handled = await handleClarificationApi(start({ posture: enabled, coordinator }));
    strictEqual(handled.status, expected, `${code} must answer ${expected}`);
    strictEqual(handled.json.error, code);
  }
});

test("a denied start is a typed rejection carrying the durable identity", async () => {
  const coordinator = fakeCoordinator({
    start: async () => {
      throw Object.assign(new Error("the managed session was denied"), {
        code: "start_denied",
        runId: "run_1",
        attemptId: "attempt_1",
      });
    },
  });
  const handled = await handleClarificationApi(start({ posture: enabled, coordinator }));
  strictEqual(handled.status, 502);
  strictEqual(handled.json.error, "start_denied");
  strictEqual(handled.json.runId, "run_1");
  strictEqual(handled.json.attemptId, "attempt_1");
});

test("the run route reads lifecycle from snapshot reads", async () => {
  const coordinator = fakeCoordinator();
  const handled = await handleClarificationApi(run({ posture: enabled, coordinator }));
  strictEqual(handled.status, 200);
  strictEqual(handled.json.run.state, "awaiting-human");
  strictEqual(handled.json.attempts[0].attemptId, "attempt_1");
  strictEqual(handled.json.snapshotSavedAt, "2026-09-18T10:00:09.000Z");
  strictEqual(handled.json.events[0].kind, "run.started");
  deepStrictEqual(coordinator.calls, [["runSection", { runId: "run_1", afterCursor: 0 }]]);
});

test("the run route carries the after cursor and refuses an unknown run", async () => {
  const coordinator = fakeCoordinator();
  const withCursor = await handleClarificationApi(
    run({ posture: enabled, coordinator, query: new URLSearchParams("run=run_1&after=7") }),
  );
  strictEqual(withCursor.status, 200);
  deepStrictEqual(coordinator.calls.at(-1), ["runSection", { runId: "run_1", afterCursor: 7 }]);

  const unknown = fakeCoordinator({
    runSection: async () => {
      throw Object.assign(new Error("no such run"), { code: "run_not_found" });
    },
  });
  const missing = await handleClarificationApi(run({ posture: enabled, coordinator: unknown }));
  strictEqual(missing.status, 404);
  strictEqual(missing.json.error, "run_not_found");

  const badCursor = await handleClarificationApi(
    run({
      posture: enabled,
      coordinator: fakeCoordinator(),
      query: new URLSearchParams("run=run_1&after=x"),
    }),
  );
  strictEqual(badCursor.status, 400);

  const noRun = await handleClarificationApi(
    run({ posture: enabled, coordinator: fakeCoordinator(), query: new URLSearchParams("") }),
  );
  strictEqual(noRun.status, 400);
});

test("the run route denies a dormant install and answers GET only", async () => {
  const coordinator = fakeCoordinator();
  const dormant = await handleClarificationApi(run({ coordinator }));
  strictEqual(dormant.status, 403);
  strictEqual(dormant.json.error, "clarification_disabled");

  const wrongMethod = await handleClarificationApi(
    run({ method: "POST", posture: enabled, coordinator }),
  );
  strictEqual(wrongMethod.status, 405);
  strictEqual(wrongMethod.json.error, "method_not_allowed");
  deepStrictEqual(coordinator.calls, []);
});

test("the posture loader names an unreadable config as its own invalid posture", async () => {
  const failing = clarificationPostureLoader(async () => {
    throw new Error("EACCES: config is not readable");
  });
  const posture = await failing();
  strictEqual(posture.posture, "invalid");
  strictEqual(posture.available, false);
  deepStrictEqual(posture.reasons, [
    "the clarification configuration could not be read: EACCES: config is not readable",
  ]);

  const working = clarificationPostureLoader(async () => ({
    enabled: true,
    provider: "openai-codex-oauth",
    dataDestination: "https://api.openai.com",
    problems: [],
  }));
  deepStrictEqual(await working(), { posture: "enabled", available: false });
});
