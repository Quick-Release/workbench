import { deepStrictEqual, match, strictEqual } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clarificationPostureLoader,
  handleClarificationApi,
  isClarificationApiRoute,
} from "./clarification-api.mjs";
import { parseClarificationConversationCommandResult } from "../../../src/schema.ts";
import { parseClarificationConversationState } from "../../../src/schema.ts";
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

const command = (overrides = {}) => ({
  method: "POST",
  pathname: "/api/clarification/runs/run_1/attempts/attempt_1/commands",
  body: JSON.stringify({
    requestId: "client-cmd-1",
    command: { kind: "prompt", text: "next question" },
  }),
  posture: disabled,
  coordinator: null,
  ...loopback,
  ...overrides,
});

const conversation = (overrides = {}) => ({
  method: "GET",
  pathname: "/api/clarification/runs/run_1/attempts/attempt_1/conversation",
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
          hostRepo: "example/project",
          issueId: "230",
          requestId: "req-1",
          state: "awaiting-human",
          createdAt: "2026-09-18T10:00:01.000Z",
          updatedAt: "2026-09-18T10:00:09.000Z",
        },
        attempts: [
          {
            attemptId: "attempt_1",
            runId: "run_1",
            hostRepo: "example/project",
            requestId: "req-1",
            dispatchIntent: { kind: "clarification-start" },
            state: "terminal",
            createdAt: "2026-09-18T10:00:03.000Z",
            updatedAt: "2026-09-18T10:00:04.000Z",
          },
        ],
        snapshot: { lifecycle: "awaiting-human" },
        snapshotSavedAt: "2026-09-18T10:00:09.000Z",
        latestCursor: 1,
        events: [
          {
            cursor: 1,
            envelope: "clarification-events/v1",
            event: {
              type: "operational",
              kind: "run.started",
              data: {},
              at: "2026-09-18T10:00:01.000Z",
            },
          },
        ],
      };
    },
    // The conversation commands record like every other coordinator call;
    // the answers are the typed results the seam validates.
    sendPrompt: async (args) => {
      calls.push(["sendPrompt", args]);
      return { sent: true, requestId: args.requestId };
    },
    steer: async (args) => {
      calls.push(["steer", args]);
      return { sent: true, requestId: args.requestId };
    },
    queueFollowUp: async (args) => {
      calls.push(["queueFollowUp", args]);
      return { sent: true, requestId: args.requestId };
    },
    clearQueue: async (args) => {
      calls.push(["clearQueue", args]);
      return { sent: true, requestId: args.requestId, cleared: [] };
    },
    stopTurn: async (args) => {
      calls.push(["stopTurn", args]);
      return {
        sent: true,
        requestId: args.requestId,
        cleared: [{ requestId: "req_queue_1", text: "queued one" }],
      };
    },
    answerDialog: async (args) => {
      calls.push(["answerDialog", args]);
      return { sent: true, requestId: args.requestId };
    },
    cancelDialog: async (args) => {
      calls.push(["cancelDialog", args]);
      return { sent: true, requestId: args.requestId };
    },
    conversationState: (args) => {
      calls.push(["conversationState", args]);
      return {
        available: true,
        sessionState: "ready",
        pendingDialogs: [
          {
            dialogId: "dialog_1",
            kind: "select",
            request: { type: "select", options: ["a", "b"] },
          },
        ],
        unsupportedCapabilities: [],
      };
    },
    runForIssue: async (args) => {
      calls.push(["runForIssue", args]);
      return {
        runId: "run_1",
        hostRepo: "example/project",
        issueId: String(args.issueNumber),
        requestId: "req-1",
        state: "active",
        createdAt: "2026-09-18T10:00:01.000Z",
        updatedAt: "2026-09-18T10:00:01.000Z",
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
  strictEqual(handled.json.events[0].event.kind, "run.started");
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

test("the start route answers POST only", async () => {
  const handled = await handleClarificationApi(start({ method: "GET", body: undefined }));
  strictEqual(handled.status, 405);
  strictEqual(handled.json.error, "method_not_allowed");
});

// --- Live observation (spec #221, ticket #231): snapshot + cursor + SSE ---
// The observation routes answer regardless of posture — records stay
// read-only inspectable even on a disabled install — so unlike start they
// take no posture. The coordinator is injected, and the contract tests run
// against a fake that records everything the seam could do to an attempt.

import { handleClarificationEvents, handleClarificationObservation } from "./clarification-api.mjs";
import { writeEventStream } from "../middleware/api-shared.mjs";
import { createClarificationCoordinator } from "../clarification/coordinator.mjs";
import { openClarificationStore } from "../clarification/store.mjs";
import {
  parseClarificationObservationResult,
  parseClarificationStreamFrame,
} from "../../../src/schema.ts";

// A real store on a temp directory for the production-shape integration
// test — the route tiers otherwise run on fakes.
const withTempStore = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-clarification-api-"));
  const store = openClarificationStore({
    hostRepo: "example/project",
    databasePath: join(directory, "runs.sqlite"),
    clock: () => "2026-09-18T00:00:00Z",
  });
  try {
    return await fn({ store });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const OBSERVATION_ROUTE = (runId) => `/api/clarification/runs/${runId}/observation`;
const EVENTS_ROUTE = (runId, attemptId) =>
  `/api/clarification/runs/${runId}/attempts/${attemptId}/events`;

// A minimal writable response stand-in: records what the seam writes and
// keeps its "close" listener so a test can hang the client up.
const fakeResponse = () => {
  const listeners = {};
  const written = [];
  const state = { statusCode: 0, ended: false };
  return {
    response: {
      set statusCode(value) {
        state.statusCode = value;
      },
      get statusCode() {
        return state.statusCode;
      },
      setHeader: (name, value) => {
        state[name] = value;
      },
      on: (event, handler) => {
        listeners[event] = handler;
      },
      write: (chunk) => {
        written.push(chunk);
        return true;
      },
      end: () => {
        state.ended = true;
      },
    },
    get written() {
      return written;
    },
    get statusCode() {
      return state.statusCode;
    },
    get ended() {
      return state.ended;
    },
    close: () => listeners.close?.(),
  };
};

// Bounded wait for a fact the event loop owes us — never a fixed sleep.
const waitForCondition = async (condition, attempts = 400) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the awaited condition never held");
};

const observation = (overrides = {}) => ({
  method: "GET",
  pathname: OBSERVATION_ROUTE("run_one"),
  query: new URLSearchParams("afterCursor=0"),
  coordinator: null,
  ...loopback,
  ...overrides,
});

const events = (overrides = {}) => ({
  method: "GET",
  pathname: EVENTS_ROUTE("run_one", "attempt_one"),
  query: new URLSearchParams("afterCursor=0"),
  coordinator: null,
  ...loopback,
  ...overrides,
});

test("the observation routes are clarification routes", () => {
  strictEqual(isClarificationApiRoute("/api/clarification/runs/run_x/observation"), true);
  strictEqual(
    isClarificationApiRoute("/api/clarification/runs/run_x/attempts/attempt_x/events"),
    true,
  );
  strictEqual(isClarificationApiRoute("/api/clarification/runs/run_x"), false);
});

test("the observation reads reject foreign hosts and wrong methods before anything else", async () => {
  const foreign = await handleClarificationObservation(observation({ host: "evil.example:1" }));
  strictEqual(foreign.status, 403);
  strictEqual(foreign.json.error, "forbidden_host");

  const post = await handleClarificationObservation(observation({ method: "POST" }));
  strictEqual(post.status, 405);
  strictEqual(post.json.error, "method_not_allowed");

  const streamForeign = await handleClarificationEvents(events({ host: "evil.example:1" }));
  strictEqual(streamForeign.status, 403);
  const streamPost = await handleClarificationEvents(events({ method: "POST" }));
  strictEqual(streamPost.status, 405);
});

test("an unreadable cursor is a named 400 before the coordinator is asked", async () => {
  const calls = [];
  const coordinator = {
    observe: (...rest) => {
      calls.push(rest);
      throw new Error("must not be reached");
    },
  };
  const fractional = await handleClarificationObservation(
    observation({ query: new URLSearchParams("afterCursor=1.5"), coordinator }),
  );
  strictEqual(fractional.status, 400);
  strictEqual(fractional.json.error, "invalid_request");
  const negative = await handleClarificationEvents(
    events({ query: new URLSearchParams("afterCursor=-3"), coordinator }),
  );
  strictEqual(negative.status, 400);
  strictEqual(calls.length, 0);
});

test("an unknown run or attempt is a typed 404 from the coordinator", async () => {
  const typedError = (code) => Object.assign(new Error(code), { code });
  const missing = await handleClarificationObservation(
    observation({
      coordinator: {
        observe: () => {
          throw typedError("run_not_found");
        },
      },
    }),
  );
  strictEqual(missing.status, 404);
  strictEqual(missing.json.error, "run_not_found");

  const missingAttempt = await handleClarificationEvents(
    events({
      coordinator: {
        streamEvents: () => {
          throw typedError("attempt_not_found");
        },
      },
    }),
  );
  strictEqual(missingAttempt.status, 404);
  strictEqual(missingAttempt.json.error, "attempt_not_found");
});

test("a cursor ahead of the ledger is a typed 400, never a fabricated gap", async () => {
  // A viewer outliving a store reset holds a cursor nobody observed; the
  // seam refuses it, and the viewer's recovery is to re-observe from zero.
  const typedError = (code) => Object.assign(new Error(code), { code });
  const ahead = await handleClarificationObservation(
    observation({
      coordinator: {
        observe: () => {
          throw typedError("invalid_cursor");
        },
      },
    }),
  );
  strictEqual(ahead.status, 400);
  strictEqual(ahead.json.error, "invalid_request");
});

test("observation without a coordinator answers the honest unavailable denial", async () => {
  const observed = await handleClarificationObservation(observation());
  strictEqual(observed.status, 501);
  strictEqual(observed.json.error, "clarification_unavailable");
  const streamed = await handleClarificationEvents(events());
  strictEqual(streamed.status, 501);
});

test("a snapshot read round-trips the schema: snapshot, events, gap", async () => {
  const result = {
    snapshot: {
      run: {
        runId: "run_one",
        hostRepo: "example/project",
        issueId: "GH-42",
        requestId: "approve-1",
        state: "awaiting-human",
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T00:00:05Z",
      },
      attempts: [
        {
          attemptId: "attempt_one",
          runId: "run_one",
          hostRepo: "example/project",
          requestId: "approve-1-attempt",
          dispatchIntent: { adapter: "pi-managed/v1", contextDigest: "sha-256:abc" },
          state: "awaiting-human",
          createdAt: "2026-09-18T00:00:01Z",
          updatedAt: "2026-09-18T00:00:05Z",
        },
      ],
    },
    latestCursor: 3,
    gap: { after: 0, firstRetainedCursor: 2 },
    events: [
      {
        cursor: 2,
        envelope: "clarification-events/v1",
        event: {
          type: "lifecycle",
          scope: "attempt",
          id: "attempt_one",
          state: "awaiting-human",
          at: "2026-09-18T00:00:05Z",
        },
      },
      {
        cursor: 3,
        envelope: "clarification-events/v1",
        event: {
          type: "conversation",
          attemptId: "attempt_one",
          session: {
            cursor: 7,
            envelope: "pi-managed/v1",
            event: { type: "error", kind: "quota", usage: { unknown: true } },
          },
        },
      },
    ],
  };
  const handled = await handleClarificationObservation(
    observation({ coordinator: { observe: () => result } }),
  );
  strictEqual(handled.status, 200);
  // The result crosses the Effect Schema — a fake that answers junk would
  // fail here, and so would a schema drift against the coordinator.
  deepStrictEqual(handled.json, parseClarificationObservationResult(result));
  // The gap divider survives the round-trip.
  strictEqual(handled.json.gap.after, 0);
});

const lifecycleFrame = (cursor, state) => ({
  cursor,
  envelope: "clarification-events/v1",
  event: {
    type: "lifecycle",
    scope: "attempt",
    id: "attempt_one",
    state,
    at: "2026-09-18T00:00:01Z",
  },
});

test("the SSE endpoint answers with a stream that detaches and never cancels", async () => {
  const calls = { detach: 0, cancelAttempt: 0, cancelRun: 0 };
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const coordinator = {
    streamEvents: () => {
      async function* frames() {
        yield lifecycleFrame(1, "active");
        await blocked;
      }
      const stream = frames();
      return {
        stream,
        detach: () => {
          calls.detach += 1;
        },
      };
    },
    // Everything the seam must never reach from a disconnect, spelled out
    // so the fence can prove it stayed silent.
    cancelAttempt: () => {
      calls.cancelAttempt += 1;
    },
    cancelRun: () => {
      calls.cancelRun += 1;
    },
  };

  const handled = await handleClarificationEvents(events({ coordinator }));
  strictEqual(handled.status, 200);
  strictEqual(handled.contentType, "text/event-stream");
  // The response part carries a detach and no cancel: there is nothing a
  // hang-up could accidentally trigger.
  strictEqual(typeof handled.detach, "function");
  strictEqual(handled.cancel, undefined);

  const fake = fakeResponse();
  const drained = writeEventStream(fake.response, handled);
  await waitForCondition(() => fake.written.length === 1);
  // The browser goes away mid-stream: the viewer detaches, the attempt's
  // cancellation commands stay untouched — the Factory 11 defect fenced.
  fake.close();
  release();
  await drained;
  strictEqual(calls.detach, 1);
  strictEqual(calls.cancelAttempt, 0);
  strictEqual(calls.cancelRun, 0);
  strictEqual(fake.written.length, 1);
  strictEqual(fake.ended, false, "a client-gone stream is never ended into a broken pipe");
});

test("writeEventStream frames the SSE envelope and ends with the stream", async () => {
  const coordinator = {
    streamEvents: () => {
      async function* frames() {
        yield lifecycleFrame(1, "active");
        yield { envelope: "clarification-events/v1", gap: { after: 0, firstRetainedCursor: 1 } };
      }
      return { stream: frames(), detach: () => {} };
    },
  };
  const handled = await handleClarificationEvents(events({ coordinator }));
  const fake = fakeResponse();
  await writeEventStream(fake.response, handled);
  strictEqual(fake.ended, true);
  deepStrictEqual(fake.written, [
    `data: ${JSON.stringify(lifecycleFrame(1, "active"))}\n\n`,
    `data: ${JSON.stringify({
      envelope: "clarification-events/v1",
      gap: { after: 0, firstRetainedCursor: 1 },
    })}\n\n`,
  ]);
  // Every frame the seam writes is a typed stream frame.
  for (const frame of fake.written) {
    parseClarificationStreamFrame(JSON.parse(frame.replace(/^data: /, "").replace(/\n\n$/, "")));
  }
});

test("the events endpoint parses its cursor before streaming", async () => {
  // With a coordinator wired, an unreadable cursor is a named 400; without
  // one, the unavailable denial precedes validation, like the start
  // route's posture denials do.
  const plain = await handleClarificationEvents(
    events({ query: new URLSearchParams("afterCursor=x") }),
  );
  strictEqual(plain.status, 501);
  const wired = await handleClarificationEvents(
    events({
      query: new URLSearchParams("afterCursor=x"),
      coordinator: {
        streamEvents: () => ({
          stream: (async function* () {})(),
          detach: () => {},
        }),
      },
    }),
  );
  strictEqual(wired.status, 400);
  strictEqual(wired.json.error, "invalid_request");
});

test("the real store and coordinator stream typed frames the schema accepts", async () => {
  await withTempStore(async ({ store }) => {
    const coordinator = createClarificationCoordinator({
      store,
      clock: () => "2026-09-18T00:00:00Z",
      tracker: {
        readContext: async () => {
          throw new Error("the observation tier never reads the tracker");
        },
      },
      sessions: {
        start: async () => {
          throw new Error("the observation tier never starts a session");
        },
      },
    });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "approve-1" });
    const { lease } = store.acquireLease({ runId: run.runId, owner: "test-controller" });
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "approve-1-attempt",
      intent: { adapter: "pi-managed/v1" },
      leaseToken: lease.token,
    });
    coordinator.publish({
      runId: run.runId,
      event: {
        type: "lifecycle",
        scope: "attempt",
        id: attempt.attemptId,
        state: "active",
        at: "2026-09-18T00:00:01Z",
      },
    });
    coordinator.publish({
      runId: run.runId,
      event: {
        type: "conversation",
        attemptId: attempt.attemptId,
        session: { cursor: 1, envelope: "pi-managed/v1", event: { type: "hello", protocol: "1" } },
      },
    });
    store.updateAttemptState({
      attemptId: attempt.attemptId,
      to: "terminal",
      leaseToken: lease.token,
    });
    coordinator.publish({
      runId: run.runId,
      event: {
        type: "lifecycle",
        scope: "attempt",
        id: attempt.attemptId,
        state: "terminal",
        at: "2026-09-18T00:00:02Z",
      },
    });

    // The snapshot read round-trips the production snapshot shape.
    const observed = await handleClarificationObservation(
      observation({
        pathname: OBSERVATION_ROUTE(run.runId),
        coordinator,
      }),
    );
    strictEqual(observed.status, 200);
    strictEqual(observed.json.snapshot.attempts.length, 1);
    strictEqual(observed.json.latestCursor, 3);

    // The SSE stream replays and ends at the terminal classification; the
    // frames are the schema's own, so a store-envelope drift cannot pass.
    const handled = await handleClarificationEvents(
      events({ pathname: EVENTS_ROUTE(run.runId, attempt.attemptId), coordinator }),
    );
    const frames = [];
    for await (const frame of handled.stream) frames.push(frame);
    strictEqual(frames.length, 3);
    deepStrictEqual(
      frames.map((frame) => frame.cursor),
      [1, 2, 3],
    );
    for (const frame of frames) parseClarificationStreamFrame(frame);
  });
});

// --- Conversation commands (spec #221, ticket #232): the Developer's
// explicit acts cross the seam as typed, schema-validated requests; the
// policy gates speak first, and the coordinator's typed rejections keep
// their own statuses.

test("the command route recognizes itself and rejects foreign hosts", async () => {
  strictEqual(
    isClarificationApiRoute("/api/clarification/runs/run_1/attempts/attempt_1/commands"),
    true,
  );
  strictEqual(
    isClarificationApiRoute("/api/clarification/runs/run_1/attempts/attempt_1/conversation"),
    true,
  );

  const foreign = await handleClarificationApi(command({ host: "host-repo.example:4051" }));
  strictEqual(foreign.status, 403);
  strictEqual(foreign.json.error, "forbidden_host");
});

test("the command route answers POST only and denies a dormant install before reading the body", async () => {
  const coordinator = fakeCoordinator();
  const wrongMethod = await handleClarificationApi(
    command({ method: "GET", coordinator, posture: enabled }),
  );
  strictEqual(wrongMethod.status, 405);
  strictEqual(wrongMethod.json.error, "method_not_allowed");

  const dormant = await handleClarificationApi(command({ coordinator }));
  strictEqual(dormant.status, 403);
  strictEqual(dormant.json.error, "clarification_disabled");
  deepStrictEqual(coordinator.calls, []);
});

test("a conversation command crosses schema validation and reaches the coordinator as its kind", async () => {
  const cases = [
    {
      body: { requestId: "c1", command: { kind: "prompt", text: "next" } },
      expected: [
        "sendPrompt",
        { runId: "run_1", attemptId: "attempt_1", requestId: "c1", text: "next" },
      ],
    },
    {
      body: { requestId: "c2", command: { kind: "steer", text: "focus" } },
      expected: [
        "steer",
        { runId: "run_1", attemptId: "attempt_1", requestId: "c2", text: "focus" },
      ],
    },
    {
      body: { requestId: "c3", command: { kind: "queue", text: "later" } },
      expected: [
        "queueFollowUp",
        { runId: "run_1", attemptId: "attempt_1", requestId: "c3", text: "later" },
      ],
    },
    {
      body: { requestId: "c4", command: { kind: "clear-queue" } },
      expected: ["clearQueue", { runId: "run_1", attemptId: "attempt_1", requestId: "c4" }],
    },
    {
      body: { requestId: "c5", command: { kind: "stop-turn" } },
      expected: ["stopTurn", { runId: "run_1", attemptId: "attempt_1", requestId: "c5" }],
    },
    {
      body: {
        requestId: "c6",
        command: { kind: "answer-dialog", dialogId: "dialog_1", value: "a" },
      },
      expected: [
        "answerDialog",
        {
          runId: "run_1",
          attemptId: "attempt_1",
          requestId: "c6",
          dialogId: "dialog_1",
          value: "a",
        },
      ],
    },
    {
      body: { requestId: "c7", command: { kind: "cancel-dialog", dialogId: "dialog_1" } },
      expected: [
        "cancelDialog",
        { runId: "run_1", attemptId: "attempt_1", requestId: "c7", dialogId: "dialog_1" },
      ],
    },
  ];
  for (const { body, expected } of cases) {
    const coordinator = fakeCoordinator();
    const handled = await handleClarificationApi(
      command({ posture: enabled, coordinator, body: JSON.stringify(body) }),
    );
    strictEqual(handled.status, 200);
    deepStrictEqual(coordinator.calls, [expected]);
    strictEqual(handled.json.sent, true);
    parseClarificationConversationCommandResult(handled.json);
  }
});

test("a malformed command body is a named 400 before the coordinator is asked", async () => {
  const coordinator = fakeCoordinator();
  for (const body of [
    "not json",
    JSON.stringify({ command: { kind: "prompt", text: "no request id" } }),
    JSON.stringify({ requestId: "c1", command: { kind: "terminate-runtime" } }),
    JSON.stringify({ requestId: "c1", command: { kind: "prompt" } }),
  ]) {
    const handled = await handleClarificationApi(command({ posture: enabled, coordinator, body }));
    strictEqual(handled.status, 400);
    strictEqual(handled.json.error, "invalid_request");
  }
  deepStrictEqual(coordinator.calls, []);
});

test("typed command rejections keep their own statuses at the seam", async () => {
  const rejections = [
    { code: "turn_in_flight", status: 409 },
    { code: "turn_not_in_flight", status: 409 },
    { code: "queue_full", status: 409 },
    { code: "dialog_not_found", status: 409 },
    { code: "conversation_unavailable", status: 503 },
    { code: "lease_expired", status: 409 },
  ];
  for (const { code, status } of rejections) {
    const coordinator = fakeCoordinator({
      sendPrompt: async () => {
        throw Object.assign(new Error(code), { code });
      },
    });
    const handled = await handleClarificationApi(command({ posture: enabled, coordinator }));
    strictEqual(handled.status, status);
    strictEqual(handled.json.error, code);
  }
});

test("the conversation state read answers the typed questions and capabilities", async () => {
  const coordinator = fakeCoordinator();
  const handled = await handleClarificationApi(conversation({ coordinator }));
  strictEqual(handled.status, 200);
  strictEqual(handled.json.available, true);
  strictEqual(handled.json.sessionState, "ready");
  strictEqual(handled.json.pendingDialogs[0].kind, "select");
  deepStrictEqual(coordinator.calls, [
    ["conversationState", { runId: "run_1", attemptId: "attempt_1" }],
  ]);
  parseClarificationConversationState(handled.json);

  const missing = fakeCoordinator({
    conversationState: () => {
      throw Object.assign(new Error("no such attempt"), { code: "attempt_not_found" });
    },
  });
  const notFound = await handleClarificationApi(conversation({ coordinator: missing }));
  strictEqual(notFound.status, 404);
  strictEqual(notFound.json.error, "attempt_not_found");

  const wrongMethod = await handleClarificationApi(
    conversation({ method: "POST", coordinator: fakeCoordinator() }),
  );
  strictEqual(wrongMethod.status, 405);
});

test("the run route finds a run by issue for the surface's reconnect-after-refresh", async () => {
  const coordinator = fakeCoordinator();
  const byIssue = await handleClarificationApi(
    run({ posture: enabled, coordinator, query: new URLSearchParams("issue=230") }),
  );
  strictEqual(byIssue.status, 200);
  deepStrictEqual(coordinator.calls, [
    ["runForIssue", { issueNumber: 230 }],
    ["runSection", { runId: "run_1", afterCursor: 0 }],
  ]);

  const unknown = fakeCoordinator({
    runForIssue: async () => null,
  });
  const absent = await handleClarificationApi(
    run({ posture: enabled, coordinator: unknown, query: new URLSearchParams("issue=231") }),
  );
  strictEqual(absent.status, 404);
  strictEqual(absent.json.error, "run_not_found");

  const badIssue = await handleClarificationApi(
    run({
      posture: enabled,
      coordinator: fakeCoordinator(),
      query: new URLSearchParams("issue=x"),
    }),
  );
  strictEqual(badIssue.status, 400);
});
