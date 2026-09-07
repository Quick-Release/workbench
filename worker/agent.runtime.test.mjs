import { expect, it } from "vitest";

import { SELF } from "cloudflare:test";

// The agent route's HTTP contract (ticket #31), driven inside the real
// workerd runtime. The Agents SDK routes /agents/<agent>/<instance> to a
// Durable Object named by the URL — one instance per repository identity,
// carried percent-encoded because repo remotes contain slashes — but the
// route mounts strictly after the same constant-time bearer-token check
// that guards the ingest routes: agent endpoints are never a wider surface
// than the ingest API (ADR 0001).

const REPO = "acme/widgets";
const AGENT_ROUTE = `/agents/submission-review-agent/${encodeURIComponent(REPO)}`;

it("rejects the agent route without a token", async () => {
  const response = await SELF.fetch(`https://example.com${AGENT_ROUTE}`);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
});

it("answers an authenticated request through the repository's agent", async () => {
  const response = await SELF.fetch(`https://example.com${AGENT_ROUTE}`, {
    headers: { Authorization: "Bearer test-ingest-token" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    agent: "submission-review-agent",
    repo: REPO,
  });
});
