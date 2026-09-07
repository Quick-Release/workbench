import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { gateRejection } from "./request-gate.mjs";

// The dashboard's backend answers only the loopback dev-server host, and
// browser requests must be same-origin (ADR 0005). The gate returns null to
// pass and a response part to reject, so every API middleware can share it.

test("passes a loopback request with no origin header", () => {
  strictEqual(gateRejection({ host: "localhost:4051" }), null);
  strictEqual(gateRejection({ host: "127.0.0.1:4051" }), null);
  strictEqual(gateRejection({ host: "[::1]:4051" }), null);
});

test("rejects a request addressed at a foreign host", () => {
  deepStrictEqual(gateRejection({ host: "lan-box.example:4051" }), {
    status: 403,
    json: {
      error: "forbidden_host",
      message: "the dashboard API answers only the loopback dev-server host",
    },
  });
  strictEqual(gateRejection({ host: undefined })?.status, 403);
});

test("passes a same-origin browser request", () => {
  strictEqual(gateRejection({ host: "localhost:4051", origin: "http://localhost:4051" }), null);
});

test("rejects a cross-origin browser request", () => {
  const rejection = gateRejection({
    host: "localhost:4051",
    origin: "http://evil.example:4051",
  });
  strictEqual(rejection?.status, 403);
  strictEqual(rejection?.json.error, "cross_origin");
});

test("rejects an unparsable origin header as cross-origin", () => {
  const rejection = gateRejection({ host: "localhost:4051", origin: "not a url" });
  strictEqual(rejection?.status, 403);
  strictEqual(rejection?.json.error, "cross_origin");
});
