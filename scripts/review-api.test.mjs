import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert";
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
  history = createRunHistory(),
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
    history,
    resolveTarget: ({ pr }) =>
      pullRequests.find((record) => record.number === pr)
        ? { baseBranch: "main", hostRepoRoot: "/host/repo" }
        : null,
    ...overrides,
  });
  return { handled, started, registry, history };
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
  const floatPr = await startHarness({ body: { engine: "coderabbit", pr: 1.5 } });
  strictEqual(floatPr.handled.status, 400);
  strictEqual(floatPr.handled.json.message, "pr must be a positive integer");
  strictEqual(floatPr.started.length, 0, "a fractional PR never invokes the runner");
  const negativePr = await startHarness({ body: { engine: "coderabbit", pr: -3 } });
  strictEqual(negativePr.handled.status, 400);
  strictEqual(negativePr.started.length, 0);
});

// --- The session history (ticket #27): finished runs stay listable ---

import { createRunHistory, handleReviewHistory } from "./review-api.mjs";

const historyRequest = (overrides = {}) =>
  handleReviewHistory({
    method: "GET",
    pathname: "/api/review/history",
    ...loopback,
    history: createRunHistory(),
    ...overrides,
  });

test("a fresh dev-server session answers a history with no runs", async () => {
  deepStrictEqual(await historyRequest(), { status: 200, json: { runs: [] } });
});

test("the history route is gate-checked and GET-only like its siblings", async () => {
  const foreign = await historyRequest({ host: "lan-box.example:4051" });
  strictEqual(foreign.status, 403);
  const wrongMethod = await historyRequest({ method: "POST" });
  strictEqual(wrongMethod.status, 405);
  strictEqual(wrongMethod.json.error, "method_not_allowed");
  strictEqual(
    await handleReviewHistory({
      method: "GET",
      pathname: "/api/tools",
      ...loopback,
      history: createRunHistory(),
    }),
    null,
  );
});

test("a completed run is recorded with engine, pr, outcome, duration, and output", async () => {
  const history = createRunHistory();
  const { handled } = await startHarness({
    events: [
      { type: "started", engine: "coderabbit", pr: 42 },
      { type: "output", stream: "stdout", text: "finding one\n" },
      { type: "output", stream: "stderr", text: "note\n" },
      { type: "exit", code: 0, signal: null, cancelled: false },
    ],
    history,
  });
  await drain(handled);

  const response = await historyRequest({ history });
  strictEqual(response.status, 200);
  const [run] = response.json.runs;
  strictEqual(run.engine, "coderabbit");
  strictEqual(run.pr, 42);
  strictEqual(run.outcome, "completed");
  strictEqual(run.output, "finding one\nnote\n");
  strictEqual(run.truncated, false);
  strictEqual(run.message, null);
  strictEqual(Number.isInteger(run.id), true);
  strictEqual(typeof run.durationMs === "number" && run.durationMs >= 0, true);
});

test("every ending records its own outcome", async () => {
  const cases = [
    {
      events: [{ type: "exit", code: 0, signal: null, cancelled: false }],
      outcome: "completed",
    },
    {
      events: [{ type: "exit", code: 1, signal: null, cancelled: false }],
      outcome: "failed",
    },
    {
      events: [{ type: "exit", code: null, signal: "SIGTERM", cancelled: true }],
      outcome: "cancelled",
    },
    {
      events: [
        {
          type: "error",
          reason: "timeout",
          message: "the coderabbit review exceeded 900s and was stopped",
        },
        { type: "exit", code: null, signal: "SIGKILL", cancelled: false },
      ],
      outcome: "timed_out",
      message: "the coderabbit review exceeded 900s and was stopped",
    },
  ];
  for (const { events, outcome, message } of cases) {
    const history = createRunHistory();
    const { handled } = await startHarness({ events, history });
    await drain(handled);
    const response = await historyRequest({ history });
    strictEqual(response.json.runs[0].outcome, outcome, JSON.stringify(events));
    strictEqual(response.json.runs[0].message, message ?? null);
  }
});

test("a re-run starts a fresh run and the history answers newest first", async () => {
  const history = createRunHistory();
  const registry = createRunRegistry();
  const first = await startHarness({
    registry,
    history,
    events: [{ type: "exit", code: 0, signal: null, cancelled: false }],
  });
  await drain(first.handled);

  // The re-run is just the normal start again — the engine's slot was
  // released with the finished run — under the same lifecycle rules.
  const rerun = await startHarness({
    registry,
    history,
    events: [
      { type: "output", stream: "stdout", text: "second pass\n" },
      { type: "exit", code: 0, signal: null, cancelled: false },
    ],
  });
  await drain(rerun.handled);

  const response = await historyRequest({ history });
  strictEqual(response.json.runs.length, 2);
  strictEqual(response.json.runs[0].output, "second pass\n", "newest first");
  strictEqual(response.json.runs[1].output, "");
  strictEqual(response.json.runs[0].id > response.json.runs[1].id, true);
  strictEqual(
    response.json.runs.every((run) => run.outcome === "completed"),
    true,
  );
});

test("the history route answers through the middleware on a fresh dev server", async () => {
  const next = middleware();
  const written = [];
  await next(
    { url: "/api/review/history", method: "GET", headers: { host: "localhost:4051" } },
    {
      statusCode: 0,
      setHeader() {},
      end(chunk) {
        written.push(chunk);
      },
    },
    () => {},
  );
  deepStrictEqual(JSON.parse(written[0]), { runs: [] });
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

// --- The issue-agent surface (issue #40): pr | issue on the same seam ---

import { ghIssueTarget } from "./review-api.mjs";

const startIssueHarness = async ({
  registry = createRunRegistry(),
  history = createRunHistory(),
  events = [],
  body = { engine: "opencode", issue: 40, model: "ollama/qwen3-coder:30b" },
  overrides = {},
} = {}) => {
  const started = [];
  const startRun = (request) => {
    const run = stubRun({ events, issue: request.issue });
    started.push(request);
    return run;
  };
  const handled = await handleReviewRunStart({
    body,
    host: "localhost:4051",
    origin: undefined,
    startRun,
    registry,
    history,
    resolveTarget: async () => ({ hostRepoRoot: "/host/repo", baseBranch: "origin/main" }),
    ...overrides,
  });
  return { handled, started, registry, history };
};

test("an issue run starts the agent engine and echoes the issue in the stream", async () => {
  const { handled, started } = await startIssueHarness({
    events: [
      {
        type: "started",
        engine: "opencode",
        issue: 40,
        model: "ollama/qwen3-coder:30b",
      },
      { type: "exit", code: 0, signal: null, cancelled: false },
    ],
  });
  strictEqual(handled.status, 200);
  strictEqual(handled.contentType, "text/event-stream");
  deepStrictEqual(started[0], {
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    baseBranch: "origin/main",
    hostRepoRoot: "/host/repo",
  });
  const frames = await drain(handled);
  strictEqual(
    frames[0],
    'data: {"type":"started","engine":"opencode","issue":40,"model":"ollama/qwen3-coder:30b"}\n\n',
  );
});

test("exactly one of pr and issue is required", async () => {
  const both = await startIssueHarness({
    body: { engine: "opencode", pr: 42, issue: 40 },
  });
  strictEqual(both.handled.status, 400);
  match(both.handled.json.message, /exactly one of pr or issue/i);
  const neither = await startIssueHarness({ body: { engine: "opencode" } });
  strictEqual(neither.handled.status, 400);
  match(neither.handled.json.message, /exactly one of pr or issue/i);
});

test("a fractional or negative issue keeps the schema's specific reason", async () => {
  const fractional = await startIssueHarness({ body: { engine: "opencode", issue: 1.5 } });
  strictEqual(fractional.handled.status, 400);
  strictEqual(fractional.handled.json.message, "issue must be a positive integer");
  const negative = await startIssueHarness({ body: { engine: "opencode", issue: -1 } });
  strictEqual(negative.handled.json.message, "issue must be a positive integer");
});

test("a model that is not ollama-qualified is rejected with its own reason", async () => {
  const response = await startIssueHarness({
    body: { engine: "opencode", issue: 40, model: "qwen3-coder:30b" },
  });
  strictEqual(response.handled.status, 400);
  match(response.handled.json.message, /ollama-qualified/);
});

test("a baseBranch that is not a safe git ref is rejected", async () => {
  const injected = await startIssueHarness({
    body: { engine: "opencode", issue: 40, baseBranch: "--upload-pack=evil" },
  });
  strictEqual(injected.handled.status, 400);
  match(injected.handled.json.message, /branch/);
});

test("an issue run sits behind the same request gate", async () => {
  const foreign = await startIssueHarness({
    overrides: { host: "lan-box.example:4051" },
  });
  strictEqual(foreign.handled.status, 403);
  strictEqual(foreign.started.length, 0);
});

test("an issue run's history entry carries the issue, not a PR", async () => {
  const history = createRunHistory();
  const { handled } = await startIssueHarness({
    history,
    events: [{ type: "exit", code: 0, signal: null, cancelled: false }],
  });
  await drain(handled);
  const response = await historyRequest({ history });
  strictEqual(response.status, 200);
  const [entry] = response.json.runs;
  strictEqual(entry.engine, "opencode");
  strictEqual(entry.issue, 40);
  strictEqual(entry.pr, null);
  strictEqual(entry.outcome, "completed");
});

test("the issue target resolves the default branch from git, or trusts an explicit one", async () => {
  const gitCalls = [];
  const resolver = ghIssueTarget({
    hostRoot: "/host/repo",
    runGit: (args, cwd) => {
      gitCalls.push([args.join(" "), cwd]);
      return { status: 0, stdout: "origin/main\n", stderr: "" };
    },
  });
  deepStrictEqual(await resolver({ issue: 40 }), {
    hostRepoRoot: "/host/repo",
    baseBranch: "origin/main",
  });
  deepStrictEqual(gitCalls, [["symbolic-ref --short refs/remotes/origin/HEAD", "/host/repo"]]);

  gitCalls.length = 0;
  deepStrictEqual(await resolver({ issue: 40, baseBranch: "main" }), {
    hostRepoRoot: "/host/repo",
    baseBranch: "main",
  });
  deepStrictEqual(gitCalls, [], "an explicit base branch skips the git call");
});

test("a git failure while resolving the default branch is a named 500", async () => {
  const registry = createRunRegistry();
  const { handled } = await startIssueHarness({
    registry,
    overrides: {
      resolveTarget: ghIssueTarget({
        hostRoot: "/host/repo",
        runGit: () => ({ status: 128, stdout: "", stderr: "fatal: no such ref" }),
      }),
    },
  });
  strictEqual(handled.status, 500);
  strictEqual(handled.json.error, "target_failed");
  match(handled.json.message, /no such ref/);
  strictEqual(registry.active("opencode"), null, "the failed start freed the engine");
});

// --- The bug gate (ADR 0012, GH-136): server-side client-first enforcement ---

import { defaultClientGate } from "./review-api.mjs";

// A derived record the way resolveIssueRecord answers (tracker grammar).
const gateIssue = (number, overrides = {}) => ({
  id: `GH-${number}`,
  title: `Issue ${number}`,
  url: `https://github.com/example/project/issues/${number}`,
  state: "open",
  assignees: [],
  phase: null,
  triageState: "unlabeled",
  deferred: false,
  category: null,
  kind: null,
  summary: "",
  labels: [],
  ...overrides,
});

const gatePolicy = (overrides = {}) => ({
  openClientBugs: [],
  coverageComplete: true,
  prerequisiteOf: () => [],
  ...overrides,
});

const gateHarness = ({ record = gateIssue(80), policy = gatePolicy(), clientGate, ...rest } = {}) =>
  startIssueHarness({
    overrides: {
      clientGate: clientGate ?? {
        resolveIssueRecord: async () => record,
        loadClientPolicyState: async () => policy,
      },
      ...rest,
    },
  });

test("a feature start is denied with typed blocking references while a client bug is open", async () => {
  const policy = gatePolicy({
    openClientBugs: [
      {
        id: "GH-12",
        title: "Checkout charges twice",
        url: "https://github.com/example/project/issues/12",
      },
    ],
  });
  const { handled, started, registry } = await gateHarness({
    record: gateIssue(80, { labels: ["enhancement"], category: "enhancement" }),
    policy,
  });
  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "client_bugs_open");
  ok(String(handled.json.message).includes("GH-12"));
  deepStrictEqual(handled.json.blocking, policy.openClientBugs);
  deepStrictEqual(started, [], "no run may start behind the denial");
  ok(registry.active("opencode") === null, "the denial released the engine slot");
});

test("an unclassifiable target cannot silently pass — fail closed", async () => {
  const policy = gatePolicy({
    openClientBugs: [
      { id: "GH-12", title: "Broken", url: "https://github.com/example/project/issues/12" },
    ],
  });
  const { handled } = await gateHarness({
    record: gateIssue(80, { labels: undefined }),
    policy,
  });
  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "client_bugs_open");
});

test("client remediation, internal bug fixes, and validated prerequisites pass", async () => {
  for (const { record, policy } of [
    { record: gateIssue(12, { labels: ["client-bug"] }), policy: gatePolicy() },
    {
      record: gateIssue(12, { labels: ["client-bug"], triageState: "wontfix", deferred: true }),
      policy: gatePolicy(),
    },
    { record: gateIssue(83, { labels: ["bug"], category: "bug" }), policy: gatePolicy() },
    {
      record: gateIssue(80, { labels: ["enhancement"], category: "enhancement" }),
      policy: gatePolicy({ prerequisiteOf: () => ["GH-12"] }),
    },
  ]) {
    const { handled, started, registry } = await gateHarness({ record, policy });
    strictEqual(handled.status, 200, `${record.id} passes the gate`);
    strictEqual(started.length, 1);
    await drain(handled);
    strictEqual(registry.active("opencode"), null);
  }
});

test("unverified coverage refuses a feature start even with zero known bugs", async () => {
  const { handled, started } = await gateHarness({
    record: gateIssue(80, { labels: ["enhancement"], category: "enhancement" }),
    policy: gatePolicy({ coverageComplete: false }),
  });
  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "client_priority_unverified");
  deepStrictEqual(started, []);
});

test("an unknown or closed target is a typed target_not_open denial", async () => {
  const { handled } = await gateHarness({ record: null });
  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "target_not_open");

  const closed = await gateHarness({ record: gateIssue(80, { state: "closed" }) });
  strictEqual(closed.handled.json.error, "target_not_open");
});

test("gate machinery failing is a client_priority_unverified denial, never a start", async () => {
  const threw = await gateHarness({
    clientGate: {
      resolveIssueRecord: async () => {
        throw new Error("rate limited");
      },
      loadClientPolicyState: async () => gatePolicy(),
    },
  });
  strictEqual(threw.handled.status, 403);
  strictEqual(threw.handled.json.error, "client_priority_unverified");
  match(threw.handled.json.message, /rate limited/);

  const policyFailed = await gateHarness({
    clientGate: {
      resolveIssueRecord: async () => gateIssue(80),
      loadClientPolicyState: async () => {
        throw new Error("network down");
      },
    },
  });
  strictEqual(policyFailed.handled.status, 403);
  strictEqual(policyFailed.handled.json.error, "client_priority_unverified");
  ok(policyFailed.registry.active("opencode") === null);
});

test("a start without the gate injected behaves as before — the gate is wiring, not luck", async () => {
  const { handled, started } = await startIssueHarness({});
  strictEqual(handled.status, 200);
  strictEqual(started.length, 1);
  await drain(handled);
});

test("a PR review start is never gated — reviews stay available", async () => {
  let gateCalls = 0;
  const { handled, started } = await startHarness({
    overrides: {
      clientGate: {
        resolveIssueRecord: async () => {
          gateCalls += 1;
          return gateIssue(80);
        },
        loadClientPolicyState: async () =>
          gatePolicy({
            openClientBugs: [
              { id: "GH-12", title: "Broken", url: "https://github.com/example/project/issues/12" },
            ],
          }),
      },
    },
  });
  strictEqual(handled.status, 200);
  strictEqual(started.length, 1);
  strictEqual(gateCalls, 0, "PR reviews ride past the bug gate");
  await drain(handled);
});

test("the default gate fails closed when the snapshot is unavailable", async () => {
  const gate = defaultClientGate({
    appDirectory: "/tmp/does-not-exist",
    hostRoot: "/host/repo",
    env: { GITHUB_TOKEN: "secret" },
    ghToken: async () => "",
    fetchImpl: async () => {
      throw new Error("no network in this test");
    },
  });
  // Both halves lean on the synced snapshot; with it unreadable every answer
  // is a thrown failure the start handler maps to a typed unverified denial.
  await rejects(() => gate.resolveIssueRecord({ issue: 7 }), /ENOENT|does not exist|not found/i);
  await rejects(() => gate.loadClientPolicyState(), /ENOENT|does not exist|not found/i);
});
