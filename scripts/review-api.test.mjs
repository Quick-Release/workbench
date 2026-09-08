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
