import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { handleLlmApi, ingestWorkerClient, isLlmApiRoute } from "./llm-api.mjs";

// The session-capture API handler (ticket #35): the worker client is a
// stub, so the tests pin the relay contract — paths forwarded, statuses
// and payloads relayed, configuration and gate failures answered — with
// no network.

const localhost = { host: "localhost:4051", origin: "http://localhost:4051" };

const workerJson = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("recognizes the capture API routes only", () => {
  strictEqual(isLlmApiRoute("/api/llm/sessions"), true);
  strictEqual(isLlmApiRoute("/api/llm/sessions/sess_1/transcript"), true);
  strictEqual(isLlmApiRoute("/api/ai/health"), false);
  strictEqual(isLlmApiRoute("/api/llm"), false);
});

test("relays the session index from the ingest worker", async () => {
  const paths = [];
  const handled = await handleLlmApi({
    method: "GET",
    pathname: "/api/llm/sessions",
    ...localhost,
    workerFetch: async (path) => {
      paths.push(path);
      return workerJson({ ok: true, sessions: [{ session_id: "sess_1", requests: 2 }] });
    },
  });
  strictEqual(handled.status, 200);
  deepStrictEqual(handled.json, { ok: true, sessions: [{ session_id: "sess_1", requests: 2 }] });
  deepStrictEqual(paths, ["/llm/sessions"]);
});

test("relays a transcript for the requested session", async () => {
  const paths = [];
  const transcript = { ok: true, session: "sess abc", messages: [], turns: [] };
  const handled = await handleLlmApi({
    method: "GET",
    pathname: "/api/llm/sessions/sess%20abc/transcript",
    ...localhost,
    workerFetch: async (path) => {
      paths.push(path);
      return workerJson(transcript);
    },
  });
  strictEqual(handled.status, 200);
  deepStrictEqual(handled.json, transcript);
  // The encoded segment reaches the worker unchanged, ready to decode.
  deepStrictEqual(paths, ["/llm/sessions/sess%20abc/transcript"]);
});

test("answers not-configured when no ingest worker is set", async () => {
  const handled = await handleLlmApi({
    method: "GET",
    pathname: "/api/llm/sessions",
    ...localhost,
    workerFetch: null,
  });
  strictEqual(handled.status, 503);
  strictEqual(handled.json.error, "not_configured");
});

test("answers method-not-allowed for non-GET requests", async () => {
  const handled = await handleLlmApi({
    method: "POST",
    pathname: "/api/llm/sessions",
    ...localhost,
    workerFetch: async () => workerJson({ ok: true }),
  });
  strictEqual(handled.status, 405);
});

test("relays the worker's own error status", async () => {
  const handled = await handleLlmApi({
    method: "GET",
    pathname: "/api/llm/sessions/nope/transcript",
    ...localhost,
    workerFetch: async () => workerJson({ ok: false, error: "not found" }, 404),
  });
  strictEqual(handled.status, 404);
  deepStrictEqual(handled.json, { ok: false, error: "not found" });
});

test("the plugin client attaches the ingest token to worker requests", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return workerJson({ ok: true, sessions: [] });
  };
  try {
    const client = ingestWorkerClient({
      TELEMETRY_INGEST_URL: "https://worker.example.com/",
      TELEMETRY_INGEST_TOKEN: "ingest-token",
    });
    await client("/llm/sessions");
    strictEqual(calls[0].url, "https://worker.example.com/llm/sessions");
    strictEqual(calls[0].init.headers.Authorization, "Bearer ingest-token");
  } finally {
    globalThis.fetch = original;
  }
  strictEqual(ingestWorkerClient({}) === null, true);
});
