import { resolve } from "node:path";

import {
  parseClarificationStartRequest,
  parseClarificationStatusResult,
} from "../../../src/schema.ts";
import { loadWorkbenchConfig } from "../../host/config.mjs";
import { evaluateClarificationPosture } from "../clarification/posture.mjs";
import { guardedApi, methodMismatch, readBody, sendJson } from "../middleware/api-shared.mjs";
import { gateRejection } from "../middleware/request-gate.mjs";

// The clarification API middleware (spec #221, ticket #222): the
// Owned-clarification slice of the execution seam, in its ship-dark
// posture. Every route gates on the posture before anything else — a
// disabled install and an invalid one get typed policy denials, never a
// generic error — and even an enabled install can only be told the honest
// truth: the clarification runtime is not part of this build yet. The
// handlers are pure — request parts in, a response part out, success
// results through the Effect Schema — and the posture is injected, so
// tests substitute one and nothing reads the host config.

const STATUS_ROUTE = /^\/api\/clarification\/?$/;
const START_ROUTE = /^\/api\/clarification\/start\/?$/;

export const isClarificationApiRoute = (pathname) =>
  STATUS_ROUTE.test(pathname) || START_ROUTE.test(pathname);

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
  return {
    status: 501,
    json: { error: "clarification_unavailable", message: NOT_AVAILABLE_MESSAGE },
  };
};

export const handleClarificationApi = async (deps) =>
  (await handleClarificationStatus(deps)) ?? (await handleClarificationStart(deps));

export const clarificationApiPlugin = () => ({
  name: "workbench-clarification-api",
  configureServer(server) {
    // The posture resolves per request from the host repo's
    // workbench.config.json — the same source-root resolution the other
    // seam middlewares use, so a config edit shows up without a restart.
    // A config that cannot be read at all is an invalid posture, never a
    // boot failure: the capability stays dark and the denial names why.
    const hostRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
    const resolvePosture = async () => {
      try {
        return evaluateClarificationPosture((await loadWorkbenchConfig(hostRoot)).clarification);
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
          posture: await resolvePosture(),
        });
        if (!handled) return next();
        sendJson(response, handled.status, handled.json);
      }),
    );
  },
});
