// Shared plumbing for the dashboard's API middlewares (the AI middleware,
// ticket #37, and the session-capture API, ticket #35).

// Reads a Node request body as UTF-8 text.
export const readBody = (request) =>
  new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });

// The shared 405 shape: every API endpoint names the method it answers.
export const methodMismatch = (expected) => ({
  status: 405,
  json: { error: "method_not_allowed", message: `this endpoint answers ${expected} only` },
});

// Writes one JSON response — the shape every API middleware answers with.
export const sendJson = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
};

// Runs one dashboard API middleware body inside the shared hardening: the
// URL is parsed once and handed over, and any exception — including a
// malformed request URL, which fails before the body even runs — is
// forwarded to next(error). Connect never consumes the async middleware's
// promise, so an unforwarded exception would leave the request hanging as
// an unhandled rejection. The body owns its own pass-through: it calls
// next() itself for requests that aren't its routes.
export const guardedApi = (body) => async (request, response, next) => {
  try {
    await body(request, response, next, new URL(request.url ?? "/", "http://localhost"));
  } catch (error) {
    next(error);
  }
};

// Writes one handler-provided stream as server-sent events: one JSON frame
// per `data:` line, the response ending with the stream. The response's own
// close is the client hang-up signal; the handler's `detach` is what a
// hang-up triggers — and nothing else. This is the seam's disconnect
// posture (spec #221, ADR 0020): a viewer going away detaches and the work
// continues; no cancellation travels through this path, which is the
// permanent fence on the Factory 11 defect where a page disconnect
// cancelled a running review.
export const writeEventStream = async (response, handled) => {
  response.statusCode = handled.status;
  response.setHeader("content-type", handled.contentType);
  let clientGone = false;
  response.on("close", () => {
    clientGone = true;
    handled.detach?.();
  });
  for await (const frame of handled.stream) {
    if (clientGone) break;
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  if (!clientGone) response.end();
};
