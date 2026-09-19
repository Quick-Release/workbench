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
  ...loopback,
  ...overrides,
});

const start = (overrides = {}) => ({
  method: "POST",
  pathname: "/api/clarification/start",
  body: "{}",
  posture: disabled,
  ...loopback,
  ...overrides,
});

test("recognizes only the clarification routes", () => {
  strictEqual(isClarificationApiRoute("/api/clarification"), true);
  strictEqual(isClarificationApiRoute("/api/clarification/"), true);
  strictEqual(isClarificationApiRoute("/api/clarification/start"), true);
  strictEqual(isClarificationApiRoute("/api/clarification/other"), false);
  strictEqual(isClarificationApiRoute("/api/review"), false);
});

test("rejects a foreign host before answering either route", async () => {
  const statusHandled = await handleClarificationApi(status({ host: "host-repo.example:4051" }));
  strictEqual(statusHandled.status, 403);
  strictEqual(statusHandled.json.error, "forbidden_host");

  const startHandled = await handleClarificationApi(start({ host: "host-repo.example:4051" }));
  strictEqual(startHandled.status, 403);
  strictEqual(startHandled.json.error, "forbidden_host");
});

test("rejects a cross-origin request before answering either route", async () => {
  const statusHandled = await handleClarificationApi(
    status({ origin: "http://evil.example:4051" }),
  );
  strictEqual(statusHandled.status, 403);
  strictEqual(statusHandled.json.error, "cross_origin");

  const startHandled = await handleClarificationApi(start({ origin: "http://evil.example:4051" }));
  strictEqual(startHandled.status, 403);
  strictEqual(startHandled.json.error, "cross_origin");
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
  match(handled.json.message, /runtime is not part of this build/);
});

test("the status route answers GET only", async () => {
  const handled = await handleClarificationApi(status({ method: "POST", body: "{}" }));
  strictEqual(handled.status, 405);
  strictEqual(handled.json.error, "method_not_allowed");
});

test("start denies a disabled posture with a typed policy denial", async () => {
  const handled = await handleClarificationApi(start());
  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "clarification_disabled");
  match(handled.json.message, /not enabled/);
});

test("start denies an invalid posture naming the offending elements", async () => {
  const handled = await handleClarificationApi(start({ posture: invalid }));
  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "clarification_posture_invalid");
  deepStrictEqual(handled.json.reasons, invalid.reasons);
  match(handled.json.message, /clarification\.provider is required/);
});

test("start answers an enabled posture with typed unavailability", async () => {
  const handled = await handleClarificationApi(start({ posture: enabled }));
  strictEqual(handled.status, 501);
  strictEqual(handled.json.error, "clarification_unavailable");
  match(handled.json.message, /runtime is not part of this build/);
});

test("start takes no fields", async () => {
  const extra = await handleClarificationApi(start({ posture: enabled, body: '{"issue":"GH-1"}' }));
  strictEqual(extra.status, 400);
  match(extra.json.message, /takes no fields/);

  const malformed = await handleClarificationApi(start({ posture: enabled, body: "not json" }));
  strictEqual(malformed.status, 400);
  match(malformed.json.message, /not valid JSON/);
});

test("a dormant install answers nothing but its typed denial, whatever the body", async () => {
  // The policy denial precedes request validation: a malformed body on a
  // disabled install must not leak a generic 400 past the posture gate.
  const malformed = await handleClarificationApi(start({ body: "not json" }));
  strictEqual(malformed.status, 403);
  strictEqual(malformed.json.error, "clarification_disabled");

  const extra = await handleClarificationApi(start({ posture: invalid, body: '{"x":1}' }));
  strictEqual(extra.status, 403);
  strictEqual(extra.json.error, "clarification_posture_invalid");
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
    const coordinator = createClarificationCoordinator({ store });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "approve-1" });
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "approve-1-attempt",
      intent: { adapter: "pi-managed/v1" },
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
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal" });
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
