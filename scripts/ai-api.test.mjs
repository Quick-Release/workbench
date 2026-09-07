import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { handleAiApi } from "./ai-api.mjs";

// The AI middleware's request-to-response contract. The model call is a
// fake: tests drive the exported handler directly and never touch a live
// provider, so CI stays hermetic and free of API costs.

const loopback = { host: "localhost:4051", origin: undefined };
const fakePr = {
  number: 12,
  title: "Add a digest scheduler",
  head: "agent/pi/digest",
  base: "main",
  author: "vvaz",
  isDraft: false,
  body: "What: runs the digest nightly.",
};

const workingDeps = {
  modelCall: async () => ({ title: "Digest scheduler", body: "Why: nightly." }),
  loadPullRequest: async (number) => (number === 12 ? fakePr : undefined),
  listCommitSubjects: async () => ["feat: nightly digest", "fix: tz drift"],
  providerKeyConfigured: true,
};

const draftRequest = (overrides = {}) =>
  handleAiApi({
    method: "POST",
    pathname: "/api/ai/draft",
    body: JSON.stringify({ pr: 12 }),
    ...loopback,
    ...workingDeps,
    ...overrides,
  });

test("passes non-AI paths through to the next middleware", async () => {
  strictEqual(await handleAiApi({ method: "GET", pathname: "/api/tools", ...loopback }), null);
});

test("rejects foreign hosts and cross-origin requests via the shared gate", async () => {
  const foreign = await handleAiApi({
    method: "GET",
    pathname: "/api/ai/health",
    host: "lan-box.example:4051",
    ...workingDeps,
  });
  strictEqual(foreign.status, 403);
  const cross = await handleAiApi({
    method: "GET",
    pathname: "/api/ai/health",
    host: "localhost:4051",
    origin: "http://evil.example:4051",
    ...workingDeps,
  });
  strictEqual(cross.status, 403);
});

test("health reports whether a provider key is configured", async () => {
  const yes = await handleAiApi({
    method: "GET",
    pathname: "/api/ai/health",
    ...loopback,
    ...workingDeps,
  });
  deepStrictEqual(yes, { status: 200, json: { configured: true } });
  const no = await handleAiApi({
    method: "GET",
    pathname: "/api/ai/health",
    ...loopback,
    ...workingDeps,
    providerKeyConfigured: false,
  });
  deepStrictEqual(no, { status: 200, json: { configured: false } });
});

test("a valid draft request returns the structured draft from the model call", async () => {
  let seen = {};
  const response = await draftRequest({
    modelCall: async (input) => {
      seen = input;
      return { title: "Digest scheduler", body: "Why: nightly." };
    },
  });
  deepStrictEqual(response, {
    status: 200,
    json: { title: "Digest scheduler", body: "Why: nightly." },
  });
  // The handler's job is the wiring: the model call sees the PR record, the
  // local commit style, and nothing else.
  strictEqual(seen.pr.number, 12);
  deepStrictEqual(seen.commitSubjects, ["feat: nightly digest", "fix: tz drift"]);
});

test("a malformed request body is a named 400", async () => {
  const notJson = await draftRequest({ body: "not json" });
  strictEqual(notJson.status, 400);
  strictEqual(notJson.json.error, "malformed_request");
  const noPr = await draftRequest({ body: JSON.stringify({ issue: 12 }) });
  strictEqual(noPr.status, 400);
  const notANumber = await draftRequest({ body: JSON.stringify({ pr: "12" }) });
  strictEqual(notANumber.status, 400);
});

test("an unconfigured provider key is a named error before any work happens", async () => {
  let called = false;
  const response = await draftRequest({
    providerKeyConfigured: false,
    modelCall: async () => {
      called = true;
      return { title: "x", body: "y" };
    },
  });
  strictEqual(response.status, 503);
  strictEqual(response.json.error, "not_configured");
  strictEqual(called, false);
});

test("an unreadable pull request is a named upstream error", async () => {
  const response = await draftRequest({ body: JSON.stringify({ pr: 999 }) });
  strictEqual(response.status, 502);
  strictEqual(response.json.error, "pull_request_unreadable");
});

test("a provider failure is caught and mapped to a readable message", async () => {
  const response = await draftRequest({
    modelCall: async () => {
      throw new Error("429: rate limited by provider");
    },
  });
  strictEqual(response.status, 502);
  strictEqual(response.json.error, "provider_error");
  strictEqual(response.json.message.includes("rate limited"), true);
});
