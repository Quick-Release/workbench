import { resolve } from "node:path";

import {
  parseClarificationManifestResult,
  parseClarificationRunResult,
  parseClarificationStartRequest,
  parseClarificationStartResult,
  parseClarificationStatusResult,
} from "../../../src/schema.ts";
import { evaluateClarificationPosture } from "../clarification/posture.mjs";
import { clarificationRuntimeLoader } from "../clarification/runtime.mjs";
import { guardedApi, methodMismatch, readBody, sendJson } from "../middleware/api-shared.mjs";
import { gateRejection } from "../middleware/request-gate.mjs";

// The clarification API middleware (spec #221, tickets #222 + #230): the
// Owned-clarification slice of the execution seam. The status route speaks
// the posture; the manifest route renders the fixed pre-start display
// contract; the start route takes the explicit act on that manifest and
// drives the clarification coordinator — durable run record and attempt
// first, managed session dispatch behind its port last; the run route
// reads a run's lifecycle from snapshot reads. The handlers are pure —
// request parts in, a response part out, success results through the
// Effect Schema — and the coordinator is injected, so tests substitute a
// fake one and nothing here touches real SQLite, the tracker, or a
// runtime.

const STATUS_ROUTE = /^\/api\/clarification\/?$/;
const MANIFEST_ROUTE = /^\/api\/clarification\/manifest\/?$/;
const START_ROUTE = /^\/api\/clarification\/start\/?$/;
const RUN_ROUTE = /^\/api\/clarification\/run\/?$/;

export const isClarificationApiRoute = (pathname) =>
  STATUS_ROUTE.test(pathname) ||
  MANIFEST_ROUTE.test(pathname) ||
  START_ROUTE.test(pathname) ||
  RUN_ROUTE.test(pathname);

const NOT_AVAILABLE_MESSAGE =
  "owned clarification is enabled — starts are recorded durably, but the managed conversation runtime is not wired on this install yet";

// The status result speaks the posture's own state; the seam adds the one
// human sentence an enabled install needs to understand what "enabled"
// means today.
export const statusResultFor = (posture) => {
  if (posture.posture === "enabled")
    return { posture: "enabled", available: false, message: NOT_AVAILABLE_MESSAGE };
  if (posture.posture === "invalid")
    return { posture: "invalid", available: false, reasons: [...posture.reasons] };
  return { posture: "disabled", available: false };
};

// The typed policy denials, shared by every clarification route but the
// status read: a dormant or misconfigured install answers only its denial,
// before the request is read any further — a malformed body on a disabled
// install must not leak a generic 400 past the posture gate.
const postureDenial = (posture) => {
  if (posture.posture === "disabled")
    return {
      status: 403,
      json: {
        error: "clarification_disabled",
        message:
          "owned clarification is not enabled on this install — the clarification block in workbench.config.json opts an internal install in",
      },
    };
  if (posture.posture === "invalid")
    return {
      status: 403,
      json: {
        error: "clarification_posture_invalid",
        reasons: [...posture.reasons],
        message: `the clarification configuration is incomplete: ${posture.reasons.join("; ")}`,
      },
    };
  return null;
};

// The coordinator's typed rejections cross the seam with their own status,
// each naming its cause — duplicate and busy starts are rejections, never
// silent queues.
const coordinatorRejection = (error) => {
  const message = String(error?.message ?? error);
  switch (error?.code) {
    case "busy":
    case "manifest_stale":
    case "request_reused":
      return { status: 409, json: { error: error.code, message } };
    case "context_unavailable":
      return { status: 503, json: { error: error.code, message } };
    case "start_denied":
      return {
        status: 502,
        json: {
          error: error.code,
          message,
          ...(error.runId ? { runId: error.runId } : {}),
          ...(error.attemptId ? { attemptId: error.attemptId } : {}),
        },
      };
    case "run_not_found":
      return { status: 404, json: { error: error.code, message } };
    default:
      return { status: 500, json: { error: error?.code ?? "coordinator_failure", message } };
  }
};

const invalidRequest = (message) => ({ status: 400, json: { error: "invalid_request", message } });

const issueFromQuery = (query) => {
  const raw = query.get("issue");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const issue = Number(raw);
  return Number.isInteger(issue) && issue > 0 ? issue : undefined;
};

export const handleClarificationStatus = ({ method, pathname, host, origin, posture }) => {
  if (!STATUS_ROUTE.test(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");

  return { status: 200, json: parseClarificationStatusResult(statusResultFor(posture)) };
};

export const handleClarificationManifest = async ({
  method,
  pathname,
  host,
  origin,
  query,
  posture,
  coordinator,
}) => {
  if (!MANIFEST_ROUTE.test(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");

  const denial = postureDenial(posture);
  if (denial) return denial;

  const issue = issueFromQuery(query);
  if (issue === undefined)
    return invalidRequest("the manifest route takes a positive integer issue query parameter");

  try {
    return {
      status: 200,
      json: parseClarificationManifestResult(await coordinator.manifest({ issueNumber: issue })),
    };
  } catch (error) {
    return coordinatorRejection(error);
  }
};

export const handleClarificationStart = async ({
  method,
  pathname,
  host,
  origin,
  body,
  posture,
  coordinator,
}) => {
  if (!START_ROUTE.test(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "POST") return methodMismatch("POST");

  const denial = postureDenial(posture);
  if (denial) return denial;

  let raw;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    return invalidRequest("request body is not valid JSON");
  }
  try {
    parseClarificationStartRequest(raw);
  } catch (error) {
    return invalidRequest(String(error?.message ?? error));
  }

  try {
    return {
      status: 200,
      json: parseClarificationStartResult(
        await coordinator.start({
          issueNumber: raw.issue,
          requestId: raw.requestId,
          revision: raw.revision,
        }),
      ),
    };
  } catch (error) {
    return coordinatorRejection(error);
  }
};

export const handleClarificationRun = async ({
  method,
  pathname,
  host,
  origin,
  query,
  posture,
  coordinator,
}) => {
  if (!RUN_ROUTE.test(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");

  const denial = postureDenial(posture);
  if (denial) return denial;

  const runId = query.get("run") ?? "";
  if (runId === "") return invalidRequest("the run route takes a run query parameter");
  const afterRaw = query.get("after");
  const afterCursor = afterRaw === null ? 0 : Number(afterRaw);
  if (!Number.isInteger(afterCursor) || afterCursor < 0)
    return invalidRequest("the run route's after cursor is a non-negative integer");

  try {
    return {
      status: 200,
      json: parseClarificationRunResult(await coordinator.runSection({ runId, afterCursor })),
    };
  } catch (error) {
    return coordinatorRejection(error);
  }
};

export const handleClarificationApi = async (deps) =>
  (await handleClarificationStatus(deps)) ??
  (await handleClarificationManifest(deps)) ??
  (await handleClarificationRun(deps)) ??
  (await handleClarificationStart(deps));

// Turns the host's config block into the posture, with the unreadable-config
// case as its own invalid posture — a config that cannot be read at all is
// never a boot failure: the capability stays dark and the denial names why.
// Extracted so tests can inject a loader instead of a host checkout.
export const clarificationPostureLoader = (loadClarificationConfig) => async () => {
  try {
    return evaluateClarificationPosture(await loadClarificationConfig());
  } catch (error) {
    return {
      posture: "invalid",
      available: false,
      reasons: [
        `the clarification configuration could not be read: ${String(error?.message ?? error)}`,
      ],
    };
  }
};

export const clarificationApiPlugin = () => ({
  name: "workbench-clarification-api",
  configureServer(server) {
    // The same source-root resolution the other seam middlewares use.
    const hostRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
    const resolveRuntime = clarificationRuntimeLoader({ hostRoot });
    server.middlewares.use(
      guardedApi(async (request, response, next, url) => {
        if (!isClarificationApiRoute(url.pathname)) return next();
        const body = request.method === "POST" ? await readBody(request) : undefined;
        const { posture, coordinator } = await resolveRuntime();
        const handled = await handleClarificationApi({
          method: request.method,
          pathname: url.pathname,
          host: request.headers.host,
          origin: request.headers.origin,
          body,
          query: url.searchParams,
          posture,
          coordinator,
        });
        if (!handled) return next();
        sendJson(response, handled.status, handled.json);
      }),
    );
  },
});
