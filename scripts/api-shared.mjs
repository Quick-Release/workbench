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
