import { resolve } from "node:path";

import {
  parseClarificationObservationResult,
  parseClarificationStartRequest,
  parseClarificationStatusResult,
} from "../../../src/schema.ts";
import { loadWorkbenchConfig } from "../../host/config.mjs";
import { evaluateClarificationPosture } from "../clarification/posture.mjs";
import {
  guardedApi,
  methodMismatch,
  readBody,
  sendJson,
  writeEventStream,
} from "../middleware/api-shared.mjs";
import { gateRejection } from "../middleware/request-gate.mjs";

// The clarification API middleware (spec #221, tickets #222 + #231): the
// Owned-clarification slice of the execution seam. The action routes speak
// the posture first — a disabled install and an invalid one get typed
// policy denials before any request body is read. The observation routes
// answer regardless of posture: run records stay read-only inspectable on
// every install, so snapshot-and-cursor reads and the live SSE stream are
// served from the injected coordinator, and with no coordinator wired yet
// (the start seam is ticket 09) they answer the same honest
// unavailable denial the start route gives. The handlers are pure — request
// parts in, a response part out, success results through the Effect Schema
// — and the coordinator is injected, so tests substitute one and nothing
// touches a live runtime.
//
// Disconnect posture (spec #221, ADR 0020): a viewer going away detaches
// and never cancels — the stream response part carries `detach` and no
// cancel of any kind, and `writeEventStream` wires only that detach to the
// response's close. Cancellation is an explicit confirmed command, which
// arrives with the controller-lease ticket.

const STATUS_ROUTE = /^\/api\/clarification\/?$/;
const START_ROUTE = /^\/api\/clarification\/start\/?$/;
const OBSERVATION_ROUTE = /^\/api\/clarification\/runs\/([^/]+)\/observation\/?$/;
const EVENTS_ROUTE = /^\/api\/clarification\/runs\/([^/]+)\/attempts\/([^/]+)\/events\/?$/;

export const isClarificationApiRoute = (pathname) =>
  STATUS_ROUTE.test(pathname) ||
  START_ROUTE.test(pathname) ||
  OBSERVATION_ROUTE.test(pathname) ||
  EVENTS_ROUTE.test(pathname);

const NOT_AVAILABLE_MESSAGE =
  "owned clarification is enabled, but its runtime is not part of this build yet";

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

export const handleClarificationStatus = ({ method, pathname, host, origin, posture }) => {
  if (!STATUS_ROUTE.test(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");

  return { status: 200, json: parseClarificationStatusResult(statusResultFor(posture)) };
};

export const handleClarificationStart = ({ method, pathname, host, origin, body, posture }) => {
  if (!START_ROUTE.test(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "POST") return methodMismatch("POST");

  // The posture denials come before the body is even parsed: a dormant
  // install must never learn anything but the typed denial, whatever the
  // request carried.
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

  let raw;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    return {
      status: 400,
      json: { error: "invalid_request", message: "request body is not valid JSON" },
    };
  }
  try {
    parseClarificationStartRequest(raw);
  } catch (error) {
    return {
      status: 400,
      json: { error: "invalid_request", message: String(error?.message ?? error) },
    };
  }
  // The schema's excess-property check has no keys to compare against on an
  // empty struct, so the no-fields rule is enforced here (the sync route's
  // pattern).
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 0)
    return {
      status: 400,
      json: { error: "invalid_request", message: "a clarification start takes no fields" },
    };

  return {
    status: 501,
    json: { error: "clarification_unavailable", message: NOT_AVAILABLE_MESSAGE },
  };
};

// The cursor the viewer reconnects from: digits only, defaulting to the
// beginning of the retained ledger. Anything else is a named 400 before
// the coordinator is consulted.
const parseAfterCursor = (query) => {
  const raw = query?.get("afterCursor") ?? "0";
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
};

// A typed coordinator error becomes the response part it deserves: an
// invisible run or attempt is a 404, a cursor that cannot be served is a
// 400, and anything else is the seam's failure, not the viewer's.
const typedFailure = (error) => {
  const code = error?.code;
  const message = String(error?.message ?? error);
  if (code === "run_not_found" || code === "attempt_not_found")
    return { status: 404, json: { error: code, message } };
  if (code === "invalid_cursor" || code === "invalid_request")
    return { status: 400, json: { error: "invalid_request", message } };
  return { status: 500, json: { error: "observation_failed", message } };
};

const unavailable = () => ({
  status: 501,
  json: { error: "clarification_unavailable", message: NOT_AVAILABLE_MESSAGE },
});

export const handleClarificationObservation = ({
  method,
  pathname,
  host,
  origin,
  query,
  coordinator,
}) => {
  const match = OBSERVATION_ROUTE.exec(pathname);
  if (!match) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");
  if (!coordinator) return unavailable();

  const afterCursor = parseAfterCursor(query);
  if (afterCursor === null)
    return {
      status: 400,
      json: {
        error: "invalid_request",
        message: "afterCursor must be a non-negative integer",
      },
    };

  let result;
  try {
    result = coordinator.observe({ runId: match[1], afterCursor });
  } catch (error) {
    return typedFailure(error);
  }
  return { status: 200, json: parseClarificationObservationResult(result) };
};

export const handleClarificationEvents = ({
  method,
  pathname,
  host,
  origin,
  query,
  coordinator,
}) => {
  const match = EVENTS_ROUTE.exec(pathname);
  if (!match) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");
  if (!coordinator) return unavailable();

  const afterCursor = parseAfterCursor(query);
  if (afterCursor === null)
    return {
      status: 400,
      json: {
        error: "invalid_request",
        message: "afterCursor must be a non-negative integer",
      },
    };

  try {
    const { stream, detach } = coordinator.streamEvents({
      runId: match[1],
      attemptId: match[2],
      afterCursor,
    });
    // The response part carries the stream and its detach — and no cancel:
    // a hang-up detaches the viewer, nothing more (the writeEventStream
    // fence).
    return { status: 200, contentType: "text/event-stream", stream, detach };
  } catch (error) {
    return typedFailure(error);
  }
};

export const handleClarificationApi = async (deps) =>
  (await handleClarificationStatus(deps)) ??
  (await handleClarificationStart(deps)) ??
  handleClarificationObservation(deps) ??
  handleClarificationEvents(deps);

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

export const clarificationApiPlugin = ({ coordinator } = {}) => ({
  name: "workbench-clarification-api",
  configureServer(server) {
    // The posture resolves per request from the host repo's
    // workbench.config.json — the same source-root resolution the other
    // seam middlewares use, so a config edit shows up without a restart.
    // The coordinator is injected by the wiring that owns the attempt
    // start (ticket 09); until then it is undefined and the observation
    // routes answer the typed unavailable denial.
    const hostRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
    const resolvePosture = clarificationPostureLoader(async () => {
      const config = await loadWorkbenchConfig(hostRoot);
      return config.clarification;
    });
    server.middlewares.use(
      guardedApi(async (request, response, next, url) => {
        if (!isClarificationApiRoute(url.pathname)) return next();
        const body = request.method === "POST" ? await readBody(request) : undefined;
        const handled = await handleClarificationApi({
          method: request.method,
          pathname: url.pathname,
          host: request.headers.host,
          origin: request.headers.origin,
          body,
          query: url.searchParams,
          posture: await resolvePosture(),
          coordinator,
        });
        if (!handled) return next();
        if (handled.stream) return writeEventStream(response, handled);
        sendJson(response, handled.status, handled.json);
      }),
    );
  },
});
