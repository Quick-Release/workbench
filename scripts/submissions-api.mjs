import { parseSubmissionRequest } from "../src/schema.ts";
import { methodMismatch, readBody } from "./api-shared.mjs";
import { gateRejection } from "./request-gate.mjs";

// The Submission seam (ticket #12): the Highlights page's Submit action
// POSTs here, and this dev-server endpoint attaches the host repo remote
// and the ingest token server-side before forwarding to the Worker's
// /submissions ingest. The browser only ever talks to localhost and
// never holds a credential (ADR 0001). The handler is pure — the worker
// client and repo remote are injected, so tests stub the network.

const SUBMISSIONS_ROUTE = /^\/api\/submissions\/?$/;

export const isSubmissionsApiRoute = (pathname) => SUBMISSIONS_ROUTE.test(pathname);

export const submissionsWorkerClient = (env) => {
  const url = env.TELEMETRY_INGEST_URL ?? "";
  const token = env.TELEMETRY_INGEST_TOKEN ?? "";
  if (!url || !token) return null;
  const base = url.replace(/\/$/, "");
  return async (path, init) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    });
};

export const handleSubmissionsApi = async ({
  method,
  pathname,
  body,
  host,
  origin,
  repoRemote,
  workerFetch,
  resolveIdentity,
}) => {
  if (!isSubmissionsApiRoute(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "POST") return methodMismatch("POST");

  if (!repoRemote || !workerFetch)
    return {
      status: 503,
      json: {
        error: "not_configured",
        message:
          "no ingest worker is configured — set TELEMETRY_INGEST_URL and TELEMETRY_INGEST_TOKEN in .env and restart `pnpm dev`",
      },
    };

  let candidate;
  try {
    candidate = JSON.parse(body ?? "");
  } catch {
    return {
      status: 400,
      json: { error: "malformed_request", message: "request body is not valid JSON" },
    };
  }

  let parsed;
  try {
    parsed = parseSubmissionRequest(candidate);
  } catch (error) {
    return {
      status: 400,
      json: { error: "malformed_request", message: String(error?.message ?? error) },
    };
  }

  // Attribution (story 19): the Developer identity rides the Submission —
  // resolved server-side, so the browser still never holds a credential.
  const developer = resolveIdentity ? await resolveIdentity() : undefined;
  const payload = {
    repoRemote,
    commitSha: parsed.sha,
    subject: parsed.subject,
    body: parsed.body,
    author: parsed.author,
    ticketRef: parsed.ticketRef,
    developer: developer ?? undefined,
    submittedAt: new Date().toISOString(),
  };
  try {
    const response = await workerFetch("/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  } catch (error) {
    return {
      status: 502,
      json: { error: "worker_unreachable", message: String(error?.message ?? error) },
    };
  }
};

export const submissionsApiPlugin = ({ repoRemote, resolveIdentity } = {}) => ({
  name: "workbench-submissions-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!isSubmissionsApiRoute(url.pathname)) return next();
      const body = request.method === "POST" ? await readBody(request) : undefined;
      const handled = await handleSubmissionsApi({
        method: request.method,
        pathname: url.pathname,
        body,
        host: request.headers.host,
        origin: request.headers.origin,
        repoRemote: repoRemote ?? process.env.WORKBENCH_REPOSITORY_URL ?? "",
        resolveIdentity,
        workerFetch: submissionsWorkerClient(process.env),
      });
      if (!handled) return next();
      response.statusCode = handled.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handled.json));
    });
  },
});
