import { deepStrictEqual, strictEqual } from "node:assert";
import { EventEmitter } from "node:events";
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
    config: { root: "/host/repo" },
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

test("cancelling keeps the claim until the stream ends, then releases", async () => {
  // The cancelled CLI is still dying inside its grace window; a replacement
  // run must stay rejected until the process is actually gone.
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

  // Still registered while the (stubbed) stream has not drained: a repeat
  // cancel reports the same cancellation instead of "no run".
  const again = handleReviewRunCancel({
    body: { engine: "coderabbit" },
    host: "localhost:4051",
    origin: undefined,
    registry,
  });
  strictEqual(again.status, 200);

  // The stream's end is what releases the engine.
  await drain(first.handled);
  strictEqual(registry.active("coderabbit"), null);
  const after = handleReviewRunCancel({
    body: { engine: "coderabbit" },
    host: "localhost:4051",
    origin: undefined,
    registry,
  });
  strictEqual(after.status, 404);
  strictEqual(after.json.error, "no_run");
});

test("the busy answer precedes the target resolution and any spawn", async () => {
  // gh never runs for an engine that cannot start anyway — and a failing
  // resolver must not mask the busy rejection.
  const registry = createRunRegistry();
  const first = await startHarness({ registry, events: [{ type: "exit", code: 0 }] });
  strictEqual(first.handled.status, 200);

  const second = await startHarness({
    registry,
    overrides: {
      resolveTarget: async () => {
        throw new Error("gh should never be consulted");
      },
    },
  });
  strictEqual(second.handled.status, 409);
  strictEqual(second.handled.json.error, "run_busy");
  strictEqual(second.started.length, 0);
});

test("a concurrent start while the first resolves its target is a busy rejection", async () => {
  // The first request holds the claim across its target resolution; the
  // second must be rejected without spawning, never queued behind it.
  let releaseFirst;
  const gate = new Promise((resolve) => (releaseFirst = resolve));
  const registry = createRunRegistry();
  const started = [];
  const startRun = (request) => {
    const run = stubRun({ events: [], pr: request.pr });
    started.push(run);
    return run;
  };
  const first = handleReviewRunStart({
    body: { engine: "coderabbit", pr: 42 },
    host: "localhost:4051",
    origin: undefined,
    startRun,
    registry,
    resolveTarget: async () => {
      await gate;
      return { baseBranch: "main", hostRepoRoot: "/host/repo" };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await handleReviewRunStart({
    body: { engine: "coderabbit", pr: 43 },
    host: "localhost:4051",
    origin: undefined,
    startRun,
    registry,
    resolveTarget: async () => ({ baseBranch: "main", hostRepoRoot: "/host/repo" }),
  });
  strictEqual(second.status, 409);
  strictEqual(second.json.error, "run_busy");
  strictEqual(started.length, 0, "the loser never reaches a CLI");

  releaseFirst();
  const done = await first;
  strictEqual(done.status, 200);
  strictEqual(started.length, 1);
});

test("a start whose runner throws releases the engine's claim", async () => {
  const registry = createRunRegistry();
  const failing = await startHarness({
    registry,
    overrides: {
      startRun: () => {
        throw new Error("spawn setup exploded");
      },
    },
  });
  strictEqual(failing.handled.status, 500);
  strictEqual(failing.handled.json.error, "run_start_failed");

  // The engine must not read busy forever after a start that never ran.
  const retry = await startHarness({ registry });
  strictEqual(retry.handled.status, 200);
});

test("a cancel during the claim window is remembered and applied at bind", async () => {
  const registry = createRunRegistry();
  registry.claim("coderabbit");
  // The run does not exist yet (target still resolving), but the cancel is
  // answered and remembered rather than dropped.
  const cancel = handleReviewRunCancel({
    body: { engine: "coderabbit" },
    host: "localhost:4051",
    origin: undefined,
    registry,
  });
  strictEqual(cancel.status, 200);
  strictEqual(cancel.json.cancelled, true);

  const run = stubRun({ events: [{ type: "exit", code: 0 }], pr: 42 });
  registry.bind("coderabbit", run);
  strictEqual(run.cancelled, true, "the remembered cancel applies at bind");
});

test("wrong methods on the run routes are named 405s", async () => {
  const drive = async (url) => {
    let captured;
    reviewApiPlugin().configureServer({
      config: { root: "/host/repo" },
      middlewares: { use: (fn) => (captured = fn) },
    });
    const response = {
      statusCode: 0,
      headers: {},
      body: undefined,
      setHeader(name, value) {
        response.headers[name] = value;
      },
      end(body) {
        response.body = body;
      },
    };
    await captured(
      {
        url,
        method: "GET",
        headers: { host: "localhost:4051" },
        on() {},
      },
      response,
      () => {
        throw new Error("next must not run for a handled route");
      },
    );
    return response;
  };

  const run = await drive("/api/review");
  strictEqual(run.statusCode, 405);
  strictEqual(JSON.parse(run.body).error, "method_not_allowed");
  const cancel = await drive("/api/review/cancel");
  strictEqual(cancel.statusCode, 405);
});

test("closing the dev server cancels every active run", async () => {
  const registry = createRunRegistry();
  const coderabbit = stubRun({ events: [{ type: "exit", code: 0 }], pr: 42 });
  const zcode = stubRun({ events: [{ type: "exit", code: 0 }], pr: 43 });
  registry.claim("coderabbit");
  registry.bind("coderabbit", coderabbit);
  registry.claim("zcode");
  registry.bind("zcode", zcode);

  // Detached process groups outlive the dev server unless the plugin stops
  // them on the HTTP server's close.
  const httpServer = new EventEmitter();
  reviewApiPlugin({ registry, startRun: () => coderabbit }).configureServer({
    config: { root: "/host/repo" },
    middlewares: { use() {} },
    httpServer,
  });
  httpServer.emit("close");

  strictEqual(coderabbit.cancelled, true, "the active coderabbit run is cancelled");
  strictEqual(zcode.cancelled, true, "the active zcode run is cancelled");
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

test("the health endpoint's named 405 survives the plugin's dispatch", async () => {
  let captured;
  reviewApiPlugin().configureServer({
    config: { root: "/host/repo" },
    middlewares: { use: (fn) => (captured = fn) },
  });
  const response = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      response.headers[name] = value;
    },
    end(body) {
      response.body = body;
    },
  };
  await captured(
    {
      url: "/api/review/health",
      method: "POST",
      headers: { host: "localhost:4051" },
      on(event, cb) {
        if (event === "end") cb();
      },
    },
    response,
    () => {
      throw new Error("next must not run for a handled route");
    },
  );
  strictEqual(response.statusCode, 405);
  strictEqual(JSON.parse(response.body).error, "method_not_allowed");
});

test("a target resolver infrastructure failure is a named 500, not a phantom 404", async () => {
  const { handled } = await startHarness({
    overrides: {
      resolveTarget: async () => {
        throw new Error("gh auth expired");
      },
    },
  });
  strictEqual(handled.status, 500);
  strictEqual(handled.json.error, "target_failed");
  strictEqual(handled.json.message.includes("gh auth expired"), true);
});

test("timeout and truncation ride the SSE stream like any other event", async () => {
  const { handled } = await startHarness({
    events: [
      { type: "output", stream: "stdout", text: "partial\n" },
      { type: "truncated" },
      { type: "error", reason: "timeout", message: "the coderabbit review exceeded 900s" },
      { type: "exit", code: null, signal: "SIGKILL", cancelled: false },
    ],
  });
  const frames = await drain(handled);
  strictEqual(frames.length, 4);
  strictEqual(
    frames[2],
    'data: {"type":"error","reason":"timeout","message":"the coderabbit review exceeded 900s"}\n\n',
  );
  strictEqual(
    frames[3],
    'data: {"type":"exit","code":null,"signal":"SIGKILL","cancelled":false}\n\n',
  );
});

test("a request body completing is not a hang-up; the response closing is", async () => {
  // IncomingMessage emits `close` when its body finishes reading — a normal
  // POST does that immediately and must not cancel the review it started.
  // The response's own close is the hang-up signal.
  const registry = createRunRegistry();
  const run = stubRun({
    events: [{ type: "exit", code: 0, signal: null, cancelled: false }],
    pr: 42,
  });
  let captured;
  reviewApiPlugin({
    startRun: () => run,
    registry,
    resolveTarget: async () => ({ baseBranch: "main", hostRepoRoot: "/host/repo" }),
  }).configureServer({
    config: { root: "/host/repo" },
    middlewares: { use: (fn) => (captured = fn) },
  });
  const listeners = {};
  const request = {
    url: "/api/review",
    method: "POST",
    headers: { host: "localhost:4051" },
    on(event, cb) {
      if (event === "data") cb(Buffer.from(JSON.stringify({ engine: "coderabbit", pr: 42 })));
      if (event === "end") cb();
    },
  };
  const response = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    setHeader() {},
    write() {},
    end() {
      response.writableEnded = true;
    },
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
    },
  };

  await captured(request, response, () => {
    throw new Error("must not pass through");
  });
  strictEqual(run.cancelled, false, "a normal POST does not cancel its own review");

  for (const cb of listeners.close ?? []) cb();
  strictEqual(run.cancelled, true, "the response closing cancels the run");
});
