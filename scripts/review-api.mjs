import { parseReviewHealth } from "../src/schema.ts";
import { methodMismatch } from "./api-shared.mjs";
import { gateRejection } from "./request-gate.mjs";
import { reviewHealth } from "./review-runner.mjs";

// The review API middleware (epic #20, ticket #24): the health endpoint the
// dashboard's PR page probes before offering a review action. The handler is
// pure — request parts in, a response part out, the answer through the seam's
// Effect Schema — and the runner probe is injected, so tests stub it and no
// live CLI is ever touched. A probe failure is a named 500: the endpoint must
// stay safe to call repeatedly even when the engines are broken.

const HEALTH_ROUTE = /^\/api\/review\/health\/?$/;

export const isReviewApiRoute = (pathname) => HEALTH_ROUTE.test(pathname);

export const handleReviewApi = async ({ method, pathname, host, origin, probeHealth }) => {
  if (!isReviewApiRoute(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");

  try {
    return { status: 200, json: parseReviewHealth(await probeHealth()) };
  } catch (error) {
    return {
      status: 500,
      json: { error: "probe_failed", message: String(error?.message ?? error) },
    };
  }
};

export const reviewApiPlugin = ({ probeHealth = () => reviewHealth() } = {}) => ({
  name: "workbench-review-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!isReviewApiRoute(url.pathname)) return next();
      const handled = await handleReviewApi({
        method: request.method,
        pathname: url.pathname,
        host: request.headers.host,
        origin: request.headers.origin,
        probeHealth,
      });
      if (!handled) return next();
      response.statusCode = handled.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handled.json));
    });
  },
});
