import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { guardedApi, sendJson } from "./api-shared.mjs";

// The dashboard API middlewares share one shape: parse the request URL,
// pass through what isn't theirs, answer JSON, and never let an exception
// hang a request — Connect does not consume the middleware's promise, so an
// exception before next() would surface only as an unhandled rejection.

const fakeResponse = () => {
  const response = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      response.headers[name] = value;
    },
    end(body) {
      response.body = body;
    },
  };
  return response;
};

test("guardedApi hands the middleware the parsed request URL", async () => {
  let seen;
  const middleware = guardedApi(async (_request, _response, _next, url) => {
    seen = url;
  });
  await middleware({ url: "/api/review/health?x=1", headers: {} }, fakeResponse(), () => {
    throw new Error("next must not run when the body answers");
  });
  strictEqual(seen.pathname, "/api/review/health");
  strictEqual(seen.searchParams.get("x"), "1");
});

test("guardedApi forwards a malformed request URL to next(error)", async () => {
  const middleware = guardedApi(async () => {
    throw new Error("the body must not run when the URL cannot parse");
  });
  const forwarded = await new Promise((resolve) => {
    middleware({ url: "http://[", headers: {} }, fakeResponse(), resolve);
  });
  strictEqual(forwarded instanceof TypeError, true);
});

test("guardedApi forwards a body exception to next(error)", async () => {
  const middleware = guardedApi(async () => {
    throw new Error("provider exploded");
  });
  const forwarded = await new Promise((resolve) => {
    middleware({ url: "/", headers: {} }, fakeResponse(), resolve);
  });
  strictEqual(forwarded instanceof Error, true);
  strictEqual(forwarded.message, "provider exploded");
});

test("sendJson writes the status, the content type, and the JSON body", () => {
  const response = fakeResponse();
  sendJson(response, 403, { error: "forbidden" });
  strictEqual(response.statusCode, 403);
  strictEqual(response.headers["content-type"], "application/json");
  strictEqual(response.body, JSON.stringify({ error: "forbidden" }));
});
