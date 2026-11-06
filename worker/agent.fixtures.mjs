import { SELF } from "cloudflare:test";
import { expect } from "vitest";

// Request helpers shared by the agent's two workerd suites (#261):
// agent.runtime.test.mjs runs at the production tick interval, so a real
// tick never fires mid-test; agent.tick.runtime.test.mjs runs at one second
// for the forced-alarm path. Both drive the same HTTP routes.

export const agentRoute = (repo) => `/agents/submission-review-agent/${encodeURIComponent(repo)}`;

export const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

export async function submit(repoRemote, sha, subject, submittedAt) {
  const response = await SELF.fetch("https://example.com/submissions", {
    method: "POST",
    headers: { Authorization: "Bearer test-ingest-token" },
    body: JSON.stringify({
      repoRemote,
      commitSha: sha,
      subject,
      body: "What and why.",
      author: "Ada Lovelace",
      submittedAt,
    }),
  });
  expect(response.status).toBe(200);
}

export async function requestDigest(route) {
  return SELF.fetch(`https://example.com${route}`, {
    headers: { Authorization: "Bearer test-ingest-token" },
  });
}
