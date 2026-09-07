import { resolve } from "node:path";

import { createDraftModelCall, providerConfigured } from "./ai-model.mjs";
import { ghPullRequestLoader, gitCommitSubjectLister } from "./ai-sources.mjs";
import { gateRejection } from "./request-gate.mjs";

// The AI middleware (ticket #37): a one-shot draft endpoint and a health
// probe, both behind the shared request gate. The handler is pure — request
// parts in, a response part out — with everything that touches the outside
// world injected: the model call, the pull-request loader, the local commit
// subjects, and whether a provider key is configured. No live provider is
// ever touched by tests.

const DRAFT_ROUTE = /^\/api\/ai\/draft\/?$/;
const HEALTH_ROUTE = /^\/api\/ai\/health\/?$/;

export const handleAiApi = async ({
  method,
  pathname,
  body,
  host,
  origin,
  modelCall,
  loadPullRequest,
  listCommitSubjects,
  providerKeyConfigured,
}) => {
  if (!DRAFT_ROUTE.test(pathname) && !HEALTH_ROUTE.test(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method === "GET" && HEALTH_ROUTE.test(pathname))
    return { status: 200, json: { configured: Boolean(providerKeyConfigured) } };

  let request;
  try {
    request = JSON.parse(body ?? "");
  } catch {
    return {
      status: 400,
      json: { error: "malformed_request", message: "request body is not valid JSON" },
    };
  }
  if (
    request === null ||
    typeof request !== "object" ||
    !Number.isInteger(request.pr) ||
    request.pr < 1
  )
    return {
      status: 400,
      json: {
        error: "malformed_request",
        message: "a draft request takes a positive integer `pr` field",
      },
    };

  if (!providerKeyConfigured)
    return {
      status: 503,
      json: {
        error: "not_configured",
        message:
          "no model provider key is configured — set ANTHROPIC_API_KEY in .env and restart `pnpm dev`",
      },
    };

  let pullRequest;
  try {
    pullRequest = await loadPullRequest(request.pr);
  } catch (error) {
    return {
      status: 502,
      json: { error: "pull_request_unreadable", message: String(error?.message ?? error) },
    };
  }
  if (!pullRequest)
    return {
      status: 502,
      json: {
        error: "pull_request_unreadable",
        message: `pull request #${request.pr} could not be read`,
      },
    };

  const commitSubjects = await listCommitSubjects();

  try {
    const draft = await modelCall({ pr: pullRequest, commitSubjects });
    return { status: 200, json: draft };
  } catch (error) {
    return {
      status: 502,
      json: { error: "provider_error", message: String(error?.message ?? error) },
    };
  }
};

const readBody = (request) =>
  new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });

export const aiApiPlugin = () => ({
  name: "workbench-ai-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!DRAFT_ROUTE.test(url.pathname) && !HEALTH_ROUTE.test(url.pathname)) return next();
      const hostRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
      const body = request.method === "POST" ? await readBody(request) : undefined;
      const handled = await handleAiApi({
        method: request.method,
        pathname: url.pathname,
        body,
        host: request.headers.host,
        origin: request.headers.origin,
        modelCall: createDraftModelCall(process.env),
        loadPullRequest: ghPullRequestLoader(),
        listCommitSubjects: gitCommitSubjectLister({ cwd: hostRoot }),
        providerKeyConfigured: providerConfigured(process.env),
      });
      if (!handled) return next();
      response.statusCode = handled.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handled.json));
    });
  },
});
