import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import test from "node:test";

import ingest from "./ingest.mjs";
import { createCaptureContext, createD1Double, createR2Double } from "./doubles.mjs";

// The session-capture proxy's HTTP contract (ticket #35), driven directly
// like the runtime-free ingest suite: request in, response out, storage
// observed through doubles. Global fetch is stubbed as the upstream
// provider — it records the forwarded origin, path, swapped credentials,
// and body — and a fake execution context collects the post-response
// capture writes so tests can await them. Auth comes before any capture
// route: an unauthenticated relay can never ship by accident.

const TOKEN = "ingest-token";
const ORIGIN = "https://provider.example.com";

function createEnv() {
  const d1 = createD1Double();
  const r2 = createR2Double();
  return {
    d1,
    r2,
    env: {
      D1_DB: d1,
      LLM_CAPTURES: r2,
      LLM_PROVIDER_ORIGIN: ORIGIN,
      LLM_PROVIDER_KEY: "provider-key",
      TELEMETRY_INGEST_TOKEN: TOKEN,
    },
  };
}

function stubUpstream(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond(calls.length, { url: String(input), init });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const jsonUpstream = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const captureRequest = ({ body, bodyText, headers = {}, token = TOKEN } = {}) =>
  new Request("https://telemetry.example.com/llm/anthropic/v1/messages", {
    method: "POST",
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      "content-type": "application/json",
      "x-session-id": "sess_abc",
      "x-request-id": "req_001",
      "x-turn-id": "turn_1",
      ...headers,
    },
    body:
      bodyText ??
      JSON.stringify(
        body ?? {
          model: "claude-x",
          messages: [{ role: "user", content: "hello" }],
        },
      ),
  });

const capturedRow = (env) => env.d1.db.prepare("SELECT * FROM llm_requests").all();

test("rejects capture without a token before anything is forwarded or stored", async () => {
  const env = createEnv();
  const upstream = stubUpstream(() => jsonUpstream({ ok: true }));
  try {
    const response = await ingest.fetch(captureRequest({ token: null }), env.env);
    strictEqual(response.status, 401);
    strictEqual(upstream.calls.length, 0);
    strictEqual(capturedRow(env).length, 0);
    strictEqual(env.r2.objects.size, 0);
  } finally {
    upstream.restore();
  }
});

test("relays a non-streaming response verbatim and captures it", async () => {
  const env = createEnv();
  const ctx = createCaptureContext();
  const requestJson = JSON.stringify({
    model: "claude-x",
    messages: [{ role: "user", content: "hello" }],
  });
  const upstream = stubUpstream(() =>
    jsonUpstream({
      id: "msg_1",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
      },
    }),
  );
  try {
    const response = await ingest.fetch(captureRequest({ bodyText: requestJson }), env.env, ctx);
    strictEqual(response.status, 200);
    const relayed = await response.json();
    strictEqual(relayed.id, "msg_1");
    strictEqual(relayed.usage.output_tokens, 5);

    // The upstream saw the provider origin with the prefix stripped, the
    // client's credential swapped for the provider key, and the same body.
    strictEqual(upstream.calls.length, 1);
    strictEqual(upstream.calls[0].url, `${ORIGIN}/v1/messages`);
    strictEqual(upstream.calls[0].init.method, "POST");
    strictEqual(upstream.calls[0].init.headers.authorization, "Bearer provider-key");
    match(String(upstream.calls[0].init.body), /"messages"/);

    await ctx.settled();

    // One queryable row: identity, server-parsed usage, sizes, keys, timing.
    const rows = capturedRow(env);
    strictEqual(rows.length, 1);
    const row = rows[0];
    strictEqual(row.session_id, "sess_abc");
    strictEqual(row.request_id, "req_001");
    strictEqual(row.turn_id, "turn_1");
    strictEqual(row.provider, "anthropic");
    strictEqual(row.model, "claude-x");
    strictEqual(row.api_format, "anthropic");
    strictEqual(row.status, "ok");
    strictEqual(row.http_status, 200);
    strictEqual(row.input_tokens, 10);
    strictEqual(row.output_tokens, 5);
    strictEqual(row.cache_read_tokens, 2);
    strictEqual(row.cache_write_tokens, 3);
    ok(row.duration_ms >= 0);
    match(row.received_at, /^\d{4}-\d{2}-\d{2}T/);
    match(row.request_key, /^llm\/\d{8}\/sess_abc\/req_001\/request\.json$/);
    match(row.response_key, /^llm\/\d{8}\/sess_abc\/req_001\/response\.json$/);
    strictEqual(env.r2.objects.get(row.request_key), requestJson);
    match(env.r2.objects.get(row.response_key), /msg_1/);
    match(
      env.r2.objects.get(`llm/${row.request_key.split("/")[1]}/sess_abc/req_001/meta.json`),
      /req_001/,
    );
  } finally {
    upstream.restore();
  }
});

const SSE_TEXT = [
  "event: message_start",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","usage":{"output_tokens":7}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

const sseUpstream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(SSE_TEXT.slice(0, 120)));
        controller.enqueue(new TextEncoder().encode(SSE_TEXT.slice(120)));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

test("streams an SSE response byte-identical while capturing usage server-side", async () => {
  const env = createEnv();
  const ctx = createCaptureContext();
  const upstream = stubUpstream(() => sseUpstream());
  try {
    const response = await ingest.fetch(captureRequest(), env.env, ctx);
    strictEqual(response.status, 200);
    strictEqual(response.headers.get("content-type"), "text/event-stream");
    const relayed = await response.text();
    strictEqual(relayed, SSE_TEXT);

    await ctx.settled();

    const row = capturedRow(env)[0];
    strictEqual(row.status, "ok");
    strictEqual(row.input_tokens, 10);
    strictEqual(row.output_tokens, 7);
    strictEqual(row.cache_read_tokens, 2);
    strictEqual(row.cache_write_tokens, 3);
    ok(row.ttft_ms !== null && row.ttft_ms >= 0, "time to first chunk is recorded");
    match(row.response_key, /response\.sse$/);
    strictEqual(env.r2.objects.get(row.response_key), SSE_TEXT);
  } finally {
    upstream.restore();
  }
});

test("a duplicate request id forwards again but stores once", async () => {
  const env = createEnv();
  const ctx = createCaptureContext();
  const upstream = stubUpstream(() =>
    jsonUpstream({ id: "msg_1", usage: { input_tokens: 1, output_tokens: 1 } }),
  );
  try {
    strictEqual((await ingest.fetch(captureRequest(), env.env, ctx)).status, 200);
    strictEqual((await ingest.fetch(captureRequest(), env.env, ctx)).status, 200);
    await ctx.settled();
    // Both replays reached the provider; the record holds one row.
    strictEqual(upstream.calls.length, 2);
    strictEqual(capturedRow(env).length, 1);
  } finally {
    upstream.restore();
  }
});

test("an upstream error relays verbatim and records an error row", async () => {
  const env = createEnv();
  const ctx = createCaptureContext();
  const upstream = stubUpstream(() => jsonUpstream({ type: "error", message: "overloaded" }, 529));
  try {
    const response = await ingest.fetch(captureRequest(), env.env, ctx);
    strictEqual(response.status, 529);
    strictEqual((await response.json()).message, "overloaded");
    await ctx.settled();
    const row = capturedRow(env)[0];
    strictEqual(row.status, "error");
    strictEqual(row.http_status, 529);
    strictEqual(row.output_tokens, null);
  } finally {
    upstream.restore();
  }
});

test("capture without the identifying headers is rejected and forwards nothing", async () => {
  const env = createEnv();
  const upstream = stubUpstream(() => jsonUpstream({ ok: true }));
  try {
    const response = await ingest.fetch(
      captureRequest({ headers: { "x-request-id": "" } }),
      env.env,
      createCaptureContext(),
    );
    strictEqual(response.status, 400);
    strictEqual(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test("the session index aggregates per session", async () => {
  const env = createEnv();
  const ctx = createCaptureContext();
  const upstream = stubUpstream((n) =>
    jsonUpstream({ id: `msg_${n}`, usage: { input_tokens: 10 * n, output_tokens: n } }),
  );
  try {
    const turn = (sessionId, requestId) =>
      ingest.fetch(
        captureRequest({ headers: { "x-session-id": sessionId, "x-request-id": requestId } }),
        env.env,
        ctx,
      );
    strictEqual((await turn("sess_a", "req_a1")).status, 200);
    strictEqual((await turn("sess_a", "req_a2")).status, 200);
    strictEqual((await turn("sess_b", "req_b1")).status, 200);
    await ctx.settled();

    const index = await ingest.fetch(
      new Request("https://telemetry.example.com/llm/sessions", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env.env,
      ctx,
    );
    strictEqual(index.status, 200);
    const { sessions } = await index.json();
    strictEqual(sessions.length, 2);
    const a = sessions.find((session) => session.session_id === "sess_a");
    strictEqual(a.requests, 2);
    deepStrictEqual(a.models, ["claude-x"]);
    strictEqual(a.input_tokens, 30);
    strictEqual(a.output_tokens, 3);
    strictEqual(a.first_at <= a.last_at, true);
    const b = sessions.find((session) => session.session_id === "sess_b");
    strictEqual(b.requests, 1);
  } finally {
    upstream.restore();
  }
});

test("the transcript reassembles the session's conversation", async () => {
  const env = createEnv();
  const ctx = createCaptureContext();
  const upstream = stubUpstream(() =>
    jsonUpstream({ id: "msg_1", usage: { input_tokens: 1, output_tokens: 1 } }),
  );
  try {
    // The first turn's request carries only the opening user message; the
    // turn-final request embeds the full conversation so far.
    const turn = (messages, requestId) =>
      ingest.fetch(
        captureRequest({
          body: { model: "claude-x", messages },
          headers: { "x-request-id": requestId },
        }),
        env.env,
        ctx,
      );
    strictEqual((await turn([{ role: "user", content: "hello" }], "req_001")).status, 200);
    const finalMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "and more" },
    ];
    strictEqual((await turn(finalMessages, "req_002")).status, 200);
    await ctx.settled();

    const transcript = await ingest.fetch(
      new Request("https://telemetry.example.com/llm/sessions/sess_abc/transcript", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env.env,
      ctx,
    );
    strictEqual(transcript.status, 200);
    const body = await transcript.json();
    deepStrictEqual(body.messages, finalMessages);
    strictEqual(body.turns.length, 2);
    deepStrictEqual(
      body.turns.map((turn) => turn.request_id),
      ["req_001", "req_002"],
    );
    strictEqual(body.turns[1].model, "claude-x");

    const missing = await ingest.fetch(
      new Request("https://telemetry.example.com/llm/sessions/nope/transcript", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env.env,
      ctx,
    );
    strictEqual(missing.status, 404);
  } finally {
    upstream.restore();
  }
});
