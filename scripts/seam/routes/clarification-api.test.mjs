import { deepStrictEqual, match, strictEqual } from "node:assert";
import test from "node:test";

import { handleClarificationApi, isClarificationApiRoute } from "./clarification-api.mjs";

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

test("the start route answers POST only", async () => {
  const handled = await handleClarificationApi(start({ method: "GET", body: undefined }));
  strictEqual(handled.status, 405);
  strictEqual(handled.json.error, "method_not_allowed");
});
