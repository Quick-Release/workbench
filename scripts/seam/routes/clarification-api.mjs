import { resolve } from "node:path";

import {
  parseClarificationConversationCommandRequest,
  parseClarificationConversationCommandResult,
  parseClarificationConversationState,
  parseClarificationManifestResult,
  parseClarificationObservationResult,
  parseClarificationRunResult,
  parseClarificationStartRequest,
  parseClarificationStartResult,
  parseClarificationStatusResult,
} from "../../../src/schema.ts";
import { evaluateClarificationPosture } from "../clarification/posture.mjs";
import { clarificationRuntimeLoader } from "../clarification/runtime.mjs";
import {
  guardedApi,
  methodMismatch,
  readBody,
  sendJson,
  writeEventStream,
} from "../middleware/api-shared.mjs";
import { gateRejection } from "../middleware/request-gate.mjs";

// The clarification API middleware (spec #221, tickets #222 + #230 + #231):
// the Owned-clarification slice of the execution seam. The status route
// speaks the posture; the manifest route renders the fixed pre-start display
// contract; the start route takes the explicit act on that manifest and
// drives the clarification coordinator — durable run record and attempt
// first, managed session dispatch behind its port last; the run route reads
// a run's lifecycle from snapshot reads; the observation routes answer
// snapshot-and-cursor reconnect reads and the live SSE stream. The handlers
// are pure — request parts in, a response part out, success results through
// the Effect Schema — and the coordinator is injected by the runtime wiring,
// so tests substitute a fake one and nothing here touches real SQLite, the
// tracker, or a runtime.
//
// Disconnect posture (spec #221, ADR 0020): a viewer going away detaches
// and never cancels — the stream response part carries `detach` and no
// cancel of any kind, and `writeEventStream` wires only that detach to the
// response's close. Cancellation is an explicit confirmed command, which
// arrives with the conversation-command surface.

const STATUS_ROUTE = /^\/api\/clarification\/?$/;
const MANIFEST_ROUTE = /^\/api\/clarification\/manifest\/?$/;
const START_ROUTE = /^\/api\/clarification\/start\/?$/;
const RUN_ROUTE = /^\/api\/clarification\/run\/?$/;
const OBSERVATION_ROUTE = /^\/api\/clarification\/runs\/([^/]+)\/observation\/?$/;
const EVENTS_ROUTE = /^\/api\/clarification\/runs\/([^/]+)\/attempts\/([^/]+)\/events\/?$/;
const COMMANDS_ROUTE = /^\/api\/clarification\/runs\/([^/]+)\/attempts\/([^/]+)\/commands\/?$/;
const CONVERSATION_ROUTE =
  /^\/api\/clarification\/runs\/([^/]+)\/attempts\/([^/]+)\/conversation\/?$/;

export const isClarificationApiRoute = (pathname) =>
  STATUS_ROUTE.test(pathname) ||
  MANIFEST_ROUTE.test(pathname) ||
  START_ROUTE.test(pathname) ||
  RUN_ROUTE.test(pathname) ||
  OBSERVATION_ROUTE.test(pathname) ||
  EVENTS_ROUTE.test(pathname) ||
  COMMANDS_ROUTE.test(pathname) ||
  CONVERSATION_ROUTE.test(pathname);

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
// each naming its cause — duplicate and busy starts, live-floor conflicts,
// and stale leases are rejections, never silent queues; an invisible run or
// attempt is a 404; a cursor that cannot be served is the viewer's 400;
// anything else is the seam's failure.
const coordinatorRejection = (error) => {
  const message = String(error?.message ?? error);
  switch (error?.code) {
    case "busy":
    case "manifest_stale":
    case "request_reused":
    case "turn_in_flight":
    case "turn_not_in_flight":
    case "queue_full":
    case "dialog_not_found":
    case "lease_required":
    case "lease_not_held":
    case "lease_expired":
      return { status: 409, json: { error: error.code, message } };
    case "invalid_cursor":
    case "invalid_request":
      return { status: 400, json: { error: "invalid_request", message } };
    case "context_unavailable":
    case "conversation_unavailable":
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
    case "attempt_not_found":
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

const runQuery = (query) => {
  const runId = query.get("run") ?? "";
  if (runId === "") return { error: invalidRequest("the run route takes a run query parameter") };
  const afterRaw = query.get("after");
  const afterCursor = afterRaw === null ? 0 : Number(afterRaw);
  if (!Number.isInteger(afterCursor) || afterCursor < 0)
    return { error: invalidRequest("the run route's after cursor is a non-negative integer") };
  return { runId, afterCursor };
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

  // Two handles on the same read: `run` for a known run id, `issue` for the
  // issue panel finding its run again after a refresh. An issue with no run
  // is a typed 404 — the panel renders the manifest, never a fabricated
  // attempt.
  const issueRaw = query.get("issue");
  if (issueRaw !== null) {
    if (!/^\d+$/.test(issueRaw) || Number(issueRaw) <= 0)
      return invalidRequest("the run route's issue parameter is a positive integer");
    if (!coordinator)
      return {
        status: 501,
        json: { error: "clarification_unavailable", message: NOT_AVAILABLE_MESSAGE },
      };
    try {
      const found = await coordinator.runForIssue({ issueNumber: Number(issueRaw) });
      if (found === null)
        return {
          status: 404,
          json: { error: "run_not_found", message: `no clarification run for issue ${issueRaw}` },
        };
      return {
        status: 200,
        json: parseClarificationRunResult(
          await coordinator.runSection({ runId: found.runId, afterCursor: 0 }),
        ),
      };
    } catch (error) {
      return coordinatorRejection(error);
    }
  }

  const parsed = runQuery(query);
  if (parsed.error) return parsed.error;

  try {
    return {
      status: 200,
      json: parseClarificationRunResult(
        await coordinator.runSection({ runId: parsed.runId, afterCursor: parsed.afterCursor }),
      ),
    };
  } catch (error) {
    return coordinatorRejection(error);
  }
};

// The conversation commands: the Developer's explicit acts, one typed route.
// The dispatch is a pure mapping — each command kind names the coordinator
// method it drives and nothing else.
const COMMAND_DISPATCH = {
  prompt: (coordinator, args, { text }) => coordinator.sendPrompt({ ...args, text }),
  steer: (coordinator, args, { text }) => coordinator.steer({ ...args, text }),
  queue: (coordinator, args, { text }) => coordinator.queueFollowUp({ ...args, text }),
  "clear-queue": (coordinator, args) => coordinator.clearQueue(args),
  "stop-turn": (coordinator, args) => coordinator.stopTurn(args),
  "answer-dialog": (coordinator, args, { dialogId, value }) =>
    coordinator.answerDialog({ ...args, dialogId, value }),
  "cancel-dialog": (coordinator, args, { dialogId }) =>
    coordinator.cancelDialog({ ...args, dialogId }),
};

export const handleClarificationConversationCommand = async ({
  method,
  pathname,
  host,
  origin,
  body,
  posture,
  coordinator,
}) => {
  const match = COMMANDS_ROUTE.exec(pathname);
  if (!match) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "POST") return methodMismatch("POST");

  const denial = postureDenial(posture);
  if (denial) return denial;
  if (!coordinator)
    return {
      status: 501,
      json: { error: "clarification_unavailable", message: NOT_AVAILABLE_MESSAGE },
    };

  let raw;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    return invalidRequest("request body is not valid JSON");
  }
  let parsed;
  try {
    parsed = parseClarificationConversationCommandRequest(raw);
  } catch (error) {
    return invalidRequest(String(error?.message ?? error));
  }

  try {
    const args = { runId: match[1], attemptId: match[2], requestId: parsed.requestId };
    const result = await COMMAND_DISPATCH[parsed.command.kind](coordinator, args, parsed.command);
    return {
      status: 200,
      json: parseClarificationConversationCommandResult(result),
    };
  } catch (error) {
    return coordinatorRejection(error);
  }
};

// The conversation's live state read: posture-free like the other reads —
// the pending questions and capability lists are evidence too.
export const handleClarificationConversationState = ({
  method,
  pathname,
  host,
  origin,
  coordinator,
}) => {
  const match = CONVERSATION_ROUTE.exec(pathname);
  if (!match) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");
  if (!coordinator)
    return {
      status: 501,
      json: { error: "clarification_unavailable", message: NOT_AVAILABLE_MESSAGE },
    };

  try {
    return {
      status: 200,
      json: parseClarificationConversationState(
        coordinator.conversationState({ runId: match[1], attemptId: match[2] }),
      ),
    };
  } catch (error) {
    return coordinatorRejection(error);
  }
};

// The cursor the viewer reconnects from: digits only, defaulting to the
// beginning of the retained ledger. Anything else is a named 400 before
// the coordinator is consulted.
const afterCursorOf = (query) => {
  const raw = query?.get("afterCursor") ?? "0";
  return /^\d+$/.test(raw) ? Number(raw) : null;
};

const INVALID_CURSOR_RESPONSE = {
  status: 400,
  json: {
    error: "invalid_request",
    message: "afterCursor must be a non-negative integer",
  },
};

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

  // The observation routes answer regardless of posture: run records stay
  // read-only inspectable on every install, even a disabled one. The
  // coordinator denial precedes validation, like the start route's posture
  // denials do.
  if (!coordinator)
    return {
      status: 501,
      json: { error: "clarification_unavailable", message: NOT_AVAILABLE_MESSAGE },
    };
  const afterCursor = afterCursorOf(query);
  if (afterCursor === null) return INVALID_CURSOR_RESPONSE;

  try {
    return {
      status: 200,
      json: parseClarificationObservationResult(
        coordinator.observe({ runId: match[1], afterCursor }),
      ),
    };
  } catch (error) {
    return coordinatorRejection(error);
  }
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

  // The stream serves the retained evidence like the observation read:
  // posture-free, read-only, open to inspection on every install. The
  // coordinator denial precedes validation.
  if (!coordinator)
    return {
      status: 501,
      json: { error: "clarification_unavailable", message: NOT_AVAILABLE_MESSAGE },
    };
  const afterCursor = afterCursorOf(query);
  if (afterCursor === null) return INVALID_CURSOR_RESPONSE;

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
    return coordinatorRejection(error);
  }
};

export const handleClarificationApi = async (deps) =>
  (await handleClarificationStatus(deps)) ??
  (await handleClarificationManifest(deps)) ??
  (await handleClarificationRun(deps)) ??
  (await handleClarificationStart(deps)) ??
  handleClarificationObservation(deps) ??
  handleClarificationEvents(deps) ??
  (await handleClarificationConversationCommand(deps)) ??
  handleClarificationConversationState(deps);

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
    // The same source-root resolution the other seam middlewares use. The
    // runtime — posture plus, on an enabled install, the store-backed
    // coordinator — resolves per request from the host repo's
    // workbench.config.json, so a config edit shows up without a restart.
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
        if (handled.stream) return writeEventStream(response, handled);
        sendJson(response, handled.status, handled.json);
      }),
    );
  },
});
