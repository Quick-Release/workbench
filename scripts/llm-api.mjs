import { methodMismatch, readBody } from "./api-shared.mjs";
import { gateRejection } from "./request-gate.mjs";

// The session-capture API (ticket #35): read-only proxies to the ingest
// worker's /llm read endpoints, behind the shared request gate. The
// handler is pure — request parts in, a response part out — with the
// worker client injected, so tests stub the worker instead of reaching
// for the network. The browser never sees the ingest token; the dev
// server holds it and attaches it server-side.

const SESSIONS_ROUTE = /^\/api\/llm\/sessions\/?$/;
const TRANSCRIPT_ROUTE = /^\/api\/llm\/sessions\/([^/]+)\/transcript\/?$/;

export const isLlmApiRoute = (pathname) =>
  SESSIONS_ROUTE.test(pathname) || TRANSCRIPT_ROUTE.test(pathname);

export const ingestWorkerClient = (env) => {
  const url = env.TELEMETRY_INGEST_URL;
  const token = env.TELEMETRY_INGEST_TOKEN;
  if (!url || !token) return null;
  return async (path) =>
    fetch(`${url.replace(/\/$/, "")}${path}`, { headers: { Authorization: `Bearer ${token}` } });
};

export const handleLlmApi = async ({ method, pathname, host, origin, workerFetch }) => {
  if (!isLlmApiRoute(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");

  if (!workerFetch)
    return {
      status: 503,
      json: {
        error: "not_configured",
        message:
          "no ingest worker is configured — set TELEMETRY_INGEST_URL and TELEMETRY_INGEST_TOKEN in .env and restart `pnpm dev`",
      },
    };

  const transcript = TRANSCRIPT_ROUTE.exec(pathname);
  const workerPath = transcript ? `/llm/sessions/${transcript[1]}/transcript` : "/llm/sessions";

  let response;
  try {
    response = await workerFetch(workerPath);
  } catch (error) {
    return {
      status: 502,
      json: { error: "worker_unreachable", message: String(error?.message ?? error) },
    };
  }
  let json;
  try {
    json = await response.json();
  } catch {
    return {
      status: 502,
      json: { error: "worker_unreachable", message: "the ingest worker sent invalid JSON" },
    };
  }
  return { status: response.status, json };
};

export const llmApiPlugin = () => ({
  name: "workbench-llm-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!isLlmApiRoute(url.pathname)) return next();
      if (request.method !== "GET") await readBody(request).catch(() => {});
      const handled = await handleLlmApi({
        method: request.method,
        pathname: url.pathname,
        host: request.headers.host,
        origin: request.headers.origin,
        workerFetch: ingestWorkerClient(process.env),
      });
      if (!handled) return next();
      response.statusCode = handled.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handled.json));
    });
  },
});
