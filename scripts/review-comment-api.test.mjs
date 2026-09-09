import { deepStrictEqual, match, strictEqual } from "node:assert";
import test from "node:test";

import { handleReviewCommentApi, reviewCommentApiPlugin } from "./review-comment-api.mjs";

// The review comment API's request-to-response contract (ticket #25). The
// runner is a stub: tests drive the exported handler directly and never
// touch a real `gh`, so what's under test is the enumerated request surface
// (engine + pr + findings, nothing else), the validated response shape, and
// the typed failure mapping.

const loopback = { host: "localhost:4051", origin: undefined };

const stubPost = (outcome) => {
  const calls = [];
  const postComment = async (request) => {
    calls.push(request);
    return outcome;
  };
  return { postComment, calls };
};

const readyOutcome = {
  ok: true,
  result: {
    engine: "coderabbit",
    pr: 25,
    message: "Review findings posted to PR #25.",
    commentUrl: "https://github.com/Quick-Release/workbench/pull/25#issuecomment-9",
  },
};

const postRequest = (overrides = {}) => {
  const { postComment, calls } = stubPost(overrides.outcome ?? readyOutcome);
  const response = handleReviewCommentApi({
    method: "POST",
    pathname: "/api/review/comment",
    body: JSON.stringify({ engine: "coderabbit", pr: 25, findings: "- a finding" }),
    ...loopback,
    cwd: "/host/repo",
    postComment,
    ...overrides,
  });
  return { response, calls };
};

test("a confirmed post forwards the enumerated request and answers the validated result", async () => {
  const { response, calls } = postRequest();
  deepStrictEqual(await response, {
    status: 200,
    json: readyOutcome.result,
  });
  // Only the enumerated fields travel, plus the host repo root the runner
  // runs gh against — no command text, no other surface.
  deepStrictEqual(calls, [
    { engine: "coderabbit", pr: 25, findings: "- a finding", cwd: "/host/repo" },
  ]);
});

test("passes non-review paths through to the next middleware", async () => {
  const { response } = postRequest({ pathname: "/api/tools" });
  strictEqual(await response, null);
});

test("rejects foreign hosts and cross-origin requests via the shared gate", async () => {
  const foreign = await postRequest({ host: "lan-box.example:4051" }).response;
  strictEqual(foreign.status, 403);
  const cross = await postRequest({ origin: "http://evil.example:4051" }).response;
  strictEqual(cross.status, 403);
});

test("wrong methods are named 405s", async () => {
  const { response } = postRequest({ method: "GET" });
  const handled = await response;
  strictEqual(handled.status, 405);
  strictEqual(handled.json.error, "method_not_allowed");
});

test("a body that is not JSON, or not a comment request, is a named 400", async () => {
  const malformed = await postRequest({ body: "not json" }).response;
  strictEqual(malformed.status, 400);
  strictEqual(malformed.json.message, "request body is not valid JSON");

  const unknownEngine = await postRequest({
    body: JSON.stringify({ engine: "claude", pr: 25, findings: "- a finding" }),
  }).response;
  strictEqual(unknownEngine.status, 400);

  const extraField = await postRequest({
    body: JSON.stringify({ engine: "coderabbit", pr: 25, findings: "- f", command: "rm -rf" }),
  }).response;
  strictEqual(extraField.status, 400);
});

test("bounds the schema alone cannot express are named 400s", async () => {
  const zeroPr = await postRequest({
    body: JSON.stringify({ engine: "coderabbit", pr: 0, findings: "- a finding" }),
  }).response;
  strictEqual(zeroPr.status, 400);
  const fractionalPr = await postRequest({
    body: JSON.stringify({ engine: "coderabbit", pr: 2.5, findings: "- a finding" }),
  }).response;
  strictEqual(fractionalPr.status, 400);

  const emptyFindings = await postRequest({
    body: JSON.stringify({ engine: "coderabbit", pr: 25, findings: "   " }),
  }).response;
  strictEqual(emptyFindings.status, 400);

  const oversizedFindings = await postRequest({
    body: JSON.stringify({ engine: "coderabbit", pr: 25, findings: "x".repeat(20_001) }),
  }).response;
  strictEqual(oversizedFindings.status, 400);
  match(oversizedFindings.json.message, /20/);
});

test("the runner's typed failures pass through with their status, error, and remediation", async () => {
  const missing = await postRequest({
    outcome: {
      ok: false,
      status: 422,
      error: "gh_auth_missing",
      remediation: "run `gh auth login` to authenticate the GitHub CLI",
    },
  }).response;
  deepStrictEqual(missing, {
    status: 422,
    json: {
      error: "gh_auth_missing",
      remediation: "run `gh auth login` to authenticate the GitHub CLI",
    },
  });

  const failed = await postRequest({
    outcome: {
      ok: false,
      status: 502,
      error: "post_failed",
      message: "GraphQL: whatever gh complained",
    },
  }).response;
  deepStrictEqual(failed, {
    status: 502,
    json: { error: "post_failed", message: "GraphQL: whatever gh complained" },
  });
});

test("a malformed request URL is forwarded to next(error), never swallowed", async () => {
  // Connect does not consume the middleware's promise: an exception before
  // next() would leave the request unanswered as an unhandled rejection.
  let captured;
  reviewCommentApiPlugin().configureServer({
    middlewares: { use: (fn) => (captured = fn) },
  });
  const failure = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("next was never called")), 2_000);
    const request = { url: "http://[", headers: {}, method: "POST" };
    const response = { statusCode: 0, setHeader() {}, end() {} };
    void captured(request, response, (error) => {
      clearTimeout(timer);
      resolve(error);
    });
  });
  const forwarded = await failure;
  strictEqual(forwarded instanceof Error, true);
});
