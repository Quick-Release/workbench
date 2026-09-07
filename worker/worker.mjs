// Deploy entry for the workbench ingest endpoint (ADR 0001): the module
// wrangler and alchemy bundle. It re-exports the agent Durable Object
// class and mounts the Agents SDK's routes strictly after the same
// constant-time bearer-token check that guards the ingest routes — agent
// endpoints are never a wider surface than the ingest API (ticket #31).
// The ingest handler itself stays runtime-free in ingest.mjs, where the
// node --test suite drives it directly.

import { routeAgentRequest } from "agents";

import { authorized, routeIngest, unauthorized } from "./ingest.mjs";

export { SubmissionReviewAgent } from "./agent.mjs";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz" && request.method === "GET") {
      return Response.json({ ok: true });
    }
    if (!authorized(request, env)) return unauthorized();
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;
    return routeIngest(request, env);
  },
};
