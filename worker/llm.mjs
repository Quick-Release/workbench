// Session capture (ticket #35): a transparent capture proxy on the ingest
// worker's /llm/anthropic/ prefix plus authenticated read APIs, mounted
// strictly after the same constant-time bearer-token check as the ingest
// routes (ADR 0001) — the capture surface is never wider than the ingest
// API. Session capture is a third reporting flow, distinct from Telemetry
// (numbers about activity, never content): it only sees traffic a
// Developer deliberately points at the proxy. The relay is the contract —
// upstream responses reach the client untouched (streamed chunked as they
// arrive), provider errors relay verbatim, and all capture happens in the
// execution context's post-response lifetime, so a storage failure can
// never alter what the agent sees. Duplicate request ids always forward
// and store once: a proxy must never block agent traffic over an ingest
// concern.

const PROVIDER_PREFIX = "/llm/anthropic";
const TRANSCRIPT_ROUTE = /^\/llm\/sessions\/([^/]+)\/transcript$/;

// Both node:sqlite and D1 surface unique violations with this phrase in
// their (differently wrapped) error messages.
const isUniqueViolation = (cause) => /UNIQUE constraint failed/.test(String(cause?.message));

export async function routeLlm(request, env, ctx) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(`${PROVIDER_PREFIX}/`)) return capture(request, env, ctx, pathname);
  if (pathname === "/llm/sessions") return listSessions(request, env);
  const transcript = TRANSCRIPT_ROUTE.exec(pathname);
  if (transcript) {
    let sessionId;
    try {
      sessionId = decodeURIComponent(transcript[1]);
    } catch {
      return Response.json({ ok: false, error: "malformed session id" }, { status: 400 });
    }
    return sessionTranscript(request, env, sessionId);
  }
  return null;
}

async function capture(request, env, ctx, pathname) {
  const sessionId = request.headers.get("x-session-id");
  const requestId = request.headers.get("x-request-id");
  if (!sessionId || !requestId) {
    return Response.json(
      { ok: false, error: "capture requires x-session-id and x-request-id headers" },
      { status: 400 },
    );
  }
  if (!env.LLM_PROVIDER_ORIGIN || !env.LLM_PROVIDER_KEY) {
    return Response.json({ ok: false, error: "capture is not configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const bodyText = await request.text();
  const headers = {};
  request.headers.forEach((value, key) => {
    // The ingest token must never travel upstream: whichever credential
    // scheme the client used — bearer or the provider's native x-api-key —
    // it is dropped here and replaced by the provider key.
    if (
      key !== "authorization" &&
      key !== "x-api-key" &&
      key !== "host" &&
      key !== "content-length"
    ) {
      headers[key] = value;
    }
  });
  headers.authorization = `Bearer ${env.LLM_PROVIDER_KEY}`;
  headers["x-api-key"] = env.LLM_PROVIDER_KEY;

  const startedAt = Date.now();
  const upstream = await fetch(
    `${env.LLM_PROVIDER_ORIGIN}${pathname.slice(PROVIDER_PREFIX.length)}${url.search}`,
    {
      method: request.method,
      headers,
      body: bodyText.length > 0 ? bodyText : undefined,
    },
  );

  // The tee: one branch streams to the client untouched, the other
  // accumulates for storage. Non-streaming bodies take the same path.
  const [clientBody, captureBody] = upstream.body ? upstream.body.tee() : [null, null];
  const relayHeaders = new Headers(upstream.headers);
  relayHeaders.delete("content-length");
  relayHeaders.delete("content-encoding");
  relayHeaders.delete("transfer-encoding");

  const capturePromise = (async () => {
    let ttftMs = null;
    let responseBytes = 0;
    const chunks = [];
    const decoder = new TextDecoder();
    let responseText = "";
    if (captureBody) {
      const reader = captureBody.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        responseBytes += value.byteLength;
        chunks.push(value);
        responseText += decoder.decode(value, { stream: true });
      }
      responseText += decoder.decode();
    }

    const receivedAt = new Date().toISOString();
    const httpStatus = upstream.status;
    const eventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const usage = parseUsage(responseText, eventStream);
    const requestBytes = new TextEncoder().encode(bodyText).length;
    const requestKey = r2Key(receivedAt, sessionId, requestId, "request.json");
    const responseKey = r2Key(
      receivedAt,
      sessionId,
      requestId,
      eventStream ? "response.sse" : "response.json",
    );
    // One row object feeds both the meta object and the D1 insert, so the
    // record cannot disagree with itself.
    const row = {
      session_id: sessionId,
      turn_id: request.headers.get("x-turn-id"),
      request_id: requestId,
      provider: "anthropic",
      model: requestModel(bodyText),
      api_format: "anthropic",
      status: httpStatus >= 200 && httpStatus < 300 ? "ok" : "error",
      http_status: httpStatus,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      duration_ms: Date.now() - startedAt,
      ttft_ms: ttftMs,
      request_bytes: requestBytes,
      response_bytes: responseBytes,
      request_key: requestKey,
      response_key: responseKey,
      received_at: receivedAt,
    };

    // A repeated request id always forwarded; storage keeps only the first
    // record of it — bodies included, so a replay can never overwrite what
    // the original row points at.
    const existing = await env.D1_DB.prepare("SELECT id FROM llm_requests WHERE request_id = ?")
      .bind(requestId)
      .first();
    if (existing) return;

    await env.LLM_CAPTURES.put(requestKey, bodyText);
    await env.LLM_CAPTURES.put(responseKey, responseText);
    await env.LLM_CAPTURES.put(
      r2Key(receivedAt, sessionId, requestId, "meta.json"),
      JSON.stringify(row, null, 2),
    );
    const columns = Object.keys(row);
    try {
      await env.D1_DB.prepare(
        `INSERT INTO llm_requests (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
        .bind(...Object.values(row))
        .run();
    } catch (cause) {
      // Backstop for concurrent replays that both pass the existence check.
      if (!isUniqueViolation(cause)) throw cause;
    }
  })();
  // Capture failures must never change the relayed response.
  capturePromise.catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(capturePromise);

  return new Response(clientBody, { status: upstream.status, headers: relayHeaders });
}

// Token counts are parsed server-side from the provider's own usage
// events, so recorded numbers never depend on client-reported values.
function parseUsage(responseText, eventStream) {
  const usage = {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
  };
  if (eventStream) {
    for (const line of responseText.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let event;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === "message_start" && event.message?.usage) {
        usage.input_tokens = event.message.usage.input_tokens ?? null;
        usage.cache_read_tokens = event.message.usage.cache_read_input_tokens ?? null;
        usage.cache_write_tokens = event.message.usage.cache_creation_input_tokens ?? null;
      }
      if (event.type === "message_delta" && event.usage?.output_tokens != null) {
        usage.output_tokens = event.usage.output_tokens;
      }
    }
    return usage;
  }
  try {
    const parsed = JSON.parse(responseText);
    const raw = parsed.usage;
    if (raw) {
      usage.input_tokens = raw.input_tokens ?? null;
      usage.output_tokens = raw.output_tokens ?? null;
      usage.cache_read_tokens = raw.cache_read_input_tokens ?? null;
      usage.cache_write_tokens = raw.cache_creation_input_tokens ?? null;
    }
  } catch {
    // A non-JSON response (e.g. a bare upstream error page) records nulls.
  }
  return usage;
}

function requestModel(bodyText) {
  try {
    return JSON.parse(bodyText).model ?? "unknown";
  } catch {
    return "unknown";
  }
}

function r2Key(receivedAt, sessionId, requestId, file) {
  // Date-partitioned per session and request, so lifecycle rules and
  // manual browsing stay sane as captures accumulate.
  const day = receivedAt.slice(0, 10).replaceAll("-", "");
  return `llm/${day}/${sessionId}/${requestId}/${file}`;
}

async function listSessions(request, env) {
  if (request.method !== "GET") return methodNotAllowed();
  const { results } = await env.D1_DB.prepare(
    "SELECT session_id, model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, received_at FROM llm_requests ORDER BY session_id, received_at",
  ).all();
  const sessions = new Map();
  for (const row of results) {
    const session = sessions.get(row.session_id) ?? {
      session_id: row.session_id,
      requests: 0,
      models: [],
      input_tokens: 0,
      output_tokens: 0,
      cache_tokens: 0,
      first_at: row.received_at,
      last_at: row.received_at,
    };
    session.requests += 1;
    if (!session.models.includes(row.model)) session.models.push(row.model);
    session.input_tokens += row.input_tokens ?? 0;
    session.output_tokens += row.output_tokens ?? 0;
    session.cache_tokens += (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0);
    session.last_at = row.received_at;
    sessions.set(row.session_id, session);
  }
  return Response.json({ ok: true, sessions: [...sessions.values()] });
}

// The Anthropic protocol is stateless per request, so the turn-final
// request embeds the full conversation history: the transcript is that
// embedded history of the session's last captured request, plus one
// metadata entry per captured turn. Raw bodies stay raw in R2 — redaction
// happens at render time, never in flight.
async function sessionTranscript(request, env, sessionId) {
  if (request.method !== "GET") return methodNotAllowed();
  const { results } = await env.D1_DB.prepare(
    "SELECT * FROM llm_requests WHERE session_id = ? ORDER BY received_at, id",
  )
    .bind(sessionId)
    .all();
  if (results.length === 0) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  const turns = results.map((row) => ({
    request_id: row.request_id,
    turn_id: row.turn_id,
    model: row.model,
    status: row.status,
    http_status: row.http_status,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    duration_ms: row.duration_ms,
    received_at: row.received_at,
  }));
  let messages = [];
  const last = results[results.length - 1];
  if (last.request_key) {
    const stored = await env.LLM_CAPTURES.get(last.request_key);
    if (stored) {
      try {
        messages = JSON.parse(await stored.text()).messages ?? [];
      } catch {
        // An unreadable body renders as an empty conversation, never a 500.
      }
    }
  }
  return Response.json({ ok: true, session: sessionId, messages, turns });
}

function methodNotAllowed() {
  return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
}
