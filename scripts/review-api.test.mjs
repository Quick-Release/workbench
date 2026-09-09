import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { handleReviewApi, reviewApiPlugin } from "./review-api.mjs";

// The review API's request-to-response contract (ticket #24). The runner is
// a stub: tests drive the exported handler directly and never probe a real
// CLI, so the health response shape is what's under test.

const loopback = { host: "localhost:4051", origin: undefined };

// The registered middleware, captured from a fake dev server.
const middleware = (probeHealth = async () => ({ engines: [] })) => {
  let captured;
  reviewApiPlugin({ probeHealth }).configureServer({
    middlewares: { use: (fn) => (captured = fn) },
  });
  return captured;
};

const readyCoderabbit = {
  engine: "coderabbit",
  state: "ready",
  version: "coderabbit 1.2.3",
};
const unconfiguredZcode = {
  engine: "zcode",
  state: "provider_missing",
  version: "0.16.5",
  remediation: "run `zcode login` to configure a model provider",
};

const healthRequest = (overrides = {}) =>
  handleReviewApi({
    method: "GET",
    pathname: "/api/review/health",
    ...loopback,
    probeHealth: async () => ({ engines: [readyCoderabbit, unconfiguredZcode] }),
    ...overrides,
  });

test("passes non-review paths through to the next middleware", async () => {
  strictEqual(await handleReviewApi({ method: "GET", pathname: "/api/tools", ...loopback }), null);
});

test("rejects foreign hosts and cross-origin requests via the shared gate", async () => {
  const foreign = await healthRequest({ host: "lan-box.example:4051" });
  strictEqual(foreign.status, 403);
  const cross = await healthRequest({ origin: "http://evil.example:4051" });
  strictEqual(cross.status, 403);
});

test("answers GET with the runner's per-engine states, validated at the seam", async () => {
  const response = await healthRequest();
  deepStrictEqual(response, {
    status: 200,
    json: { engines: [readyCoderabbit, unconfiguredZcode] },
  });
});

test("wrong methods are named 405s", async () => {
  const response = await healthRequest({ method: "POST" });
  strictEqual(response.status, 405);
  strictEqual(response.json.error, "method_not_allowed");
});

test("a probe failure is a named 500, not a hanging or crashing endpoint", async () => {
  const response = await healthRequest({
    probeHealth: async () => {
      throw new Error("spawn bailed");
    },
  });
  strictEqual(response.status, 500);
  strictEqual(response.json.error, "probe_failed");
  strictEqual(response.json.message.includes("spawn bailed"), true);
});

test("a runner answer that violates the health shape is a named 500", async () => {
  const response = await healthRequest({
    probeHealth: async () => ({ engines: [{ engine: "coderabbit", state: "ready" }] }),
  });
  strictEqual(response.status, 500);
  strictEqual(response.json.error, "probe_failed");
});

test("a malformed request URL is forwarded to next(error), never swallowed", async () => {
  // Connect does not consume the middleware's promise: an exception before
  // next() would leave the request unanswered as an unhandled rejection.
  const next = middleware();
  const failure = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("next was never called")), 2_000);
    const request = { url: "http://[", headers: {} };
    const response = { statusCode: 0, setHeader() {}, end() {} };
    void next(request, response, (error) => {
      clearTimeout(timer);
      resolve(error);
    });
  });
  const forwarded = await failure;
  strictEqual(forwarded instanceof Error, true);
});

// --- The run half (ticket #26): start, stream, cancel, single-run ---

import { handleReviewRunCancel, handleReviewRunStart } from "./review-api.mjs";
import { createRunRegistry } from "./review-runner.mjs";

// A stub runner: the events are pre-scripted, `cancel` is observable, and
// the captured target is what the endpoint resolved for the run.
const stubRun = ({ events, pr }) => {
  const run = {
    pr,
    cancelled: false,
    cancel() {
      run.cancelled = true;
    },
  };
  run.events = (async function* () {
    yield* events;
  })();
  return run;
};

const startHarness = async ({
  registry = createRunRegistry(),
  events = [],
  pullRequests = [{ number: 42, base: "main" }],
  body = { engine: "coderabbit", pr: 42 },
  overrides = {},
} = {}) => {
  const started = [];
  const startRun = (request) => {
    const run = stubRun({ events, pr: request.pr });
    started.push(run);
    return run;
  };
  const handled = await handleReviewRunStart({
    body,
    host: "localhost:4051",
    origin: undefined,
    startRun,
    registry,
    resolveTarget: ({ pr }) =>
      pullRequests.find((record) => record.number === pr)
        ? { baseBranch: "main", hostRepoRoot: "/host/repo" }
        : null,
    ...overrides,
  });
  return { handled, started, registry };
};

const drain = async (handled) => {
  const frames = [];
  for await (const event of handled.stream) frames.push(`data: ${JSON.stringify(event)}\n\n`);
  return frames;
};

test("a valid start answers an SSE stream of the runner's events", async () => {
  const { handled, started } = await startHarness({
    events: [
      { type: "started", engine: "coderabbit", pr: 42 },
      { type: "exit", code: 0, signal: null, cancelled: false },
    ],
  });
  strictEqual(handled.status, 200);
  strictEqual(handled.contentType, "text/event-stream");
  deepStrictEqual(started[0].pr, 42);
  const frames = await drain(handled);
  deepStrictEqual(frames, [
    'data: {"type":"started","engine":"coderabbit","pr":42}\n\n',
    'data: {"type":"exit","code":0,"signal":null,"cancelled":false}\n\n',
  ]);
});

test("a second start on the same engine is a typed busy rejection, not a queue", async () => {
  // The first run is still active: its events are never drained.
  const first = await startHarness({ events: [{ type: "exit", code: 0 }] });
  strictEqual(first.handled.status, 200);

  const second = await startHarness({ registry: first.registry });
  strictEqual(second.handled.status, 409);
  strictEqual(second.handled.json.error, "run_busy");
  strictEqual(second.handled.json.engine, "coderabbit");
  strictEqual(second.started.length, 0, "the runner is never started while busy");
});

test("the registry releases on stream end, so the engine can run again", async () => {
  const { handled, registry } = await startHarness({
    events: [{ type: "exit", code: 0, signal: null, cancelled: false }],
  });
  await drain(handled);
  strictEqual(registry.active("coderabbit"), null);
});

test("an invalid run request is a named 400 before anything spawns", async () => {
  const missing = await startHarness({ body: { engine: "coderabbit" } });
  strictEqual(missing.handled.status, 400);
  strictEqual(missing.handled.json.error, "invalid_request");
  const unknownEngine = await startHarness({ body: { engine: "magic-ai", pr: 42 } });
  strictEqual(unknownEngine.handled.json.error, "invalid_request");
  strictEqual(unknownEngine.started.length, 0);
});

test("a PR the snapshot does not know is a named 404", async () => {
  const { handled, started } = await startHarness({
    body: { engine: "coderabbit", pr: 424242 },
  });
  strictEqual(handled.status, 404);
  strictEqual(handled.json.error, "pr_unknown");
  strictEqual(started.length, 0);
});

test("cancelling the active run cancels it; nothing active is a named 404", async () => {
  const first = await startHarness({ events: [{ type: "exit", code: 0 }] });
  const registry = first.registry;

  const cancel = handleReviewRunCancel({
    body: { engine: "coderabbit" },
    host: "localhost:4051",
    origin: undefined,
    registry,
  });
  strictEqual(cancel.status, 200);
  strictEqual(cancel.json.cancelled, true);
  strictEqual(first.started[0].cancelled, true);

  const again = handleReviewRunCancel({
    body: { engine: "coderabbit" },
    host: "localhost:4051",
    origin: undefined,
    registry,
  });
  strictEqual(again.status, 404);
  strictEqual(again.json.error, "no_run");
});

test("run start and cancel sit behind the same request gate", async () => {
  const foreign = await startHarness({
    overrides: { host: "lan-box.example:4051" },
  });
  strictEqual(foreign.handled.status, 403);
  const cancelForeign = handleReviewRunCancel({
    body: { engine: "coderabbit" },
    host: "lan-box.example:4051",
    origin: undefined,
    registry: createRunRegistry(),
  });
  strictEqual(cancelForeign.status, 403);
});
