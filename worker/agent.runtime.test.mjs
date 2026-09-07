import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";

// The agent route's HTTP contract (tickets #31 and #32), driven inside the
// real workerd runtime. The Agents SDK routes /agents/<agent>/<instance> to
// a Durable Object named by the URL — one instance per repository identity,
// carried percent-encoded because repo remotes contain slashes — but the
// route mounts strictly after the same constant-time bearer-token check
// that guards the ingest routes: agent endpoints are never a wider surface
// than the ingest API (ADR 0001). The digest itself is exercised through
// the real ingest path: submissions go in via POST /submissions, the agent
// reads them back through the same D1 binding production uses.

const REPO = "git@github.com:acme/widgets.git";
const AGENT_ROUTE = `/agents/submission-review-agent/${encodeURIComponent(REPO)}`;

beforeAll(async () => {
  await applyD1Migrations(env.D1_DB, env.TEST_MIGRATIONS);
});

const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

async function submit(repoRemote, sha, subject, submittedAt) {
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

async function requestDigest(route = AGENT_ROUTE) {
  return SELF.fetch(`https://example.com${route}`, {
    headers: { Authorization: "Bearer test-ingest-token" },
  });
}

it("rejects the agent route without a token", async () => {
  const response = await SELF.fetch(`https://example.com${AGENT_ROUTE}`);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
});

it("digests the requested repository's pending submissions on demand", async () => {
  await submit(REPO, "a".repeat(40), "feat: first pending submission", hoursAgo(2));
  await submit(REPO, "b".repeat(40), "fix: second pending submission", hoursAgo(72));
  await submit(
    "git@github.com:acme/other.git",
    "c".repeat(40),
    "feat: another repo's submission",
    hoursAgo(2),
  );

  const response = await requestDigest();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.repo).toBe(REPO);
  expect(body.digest.total).toBe(2);
  expect(body.digest.byAge).toEqual({ fresh: 1, aging: 1, stale: 0 });
  expect(body.digest.oldestAgeDays).toBe(3);
  // Oldest first: the at-risk work reads first.
  expect(body.digest.items.map((item) => item.sha)).toEqual(["b".repeat(40), "a".repeat(40)]);
  // The first run has no predecessor to report.
  expect(body.previous).toBeNull();
});

it("digests an empty repository to zeros", async () => {
  const emptyRoute = `/agents/submission-review-agent/${encodeURIComponent("git@github.com:acme/empty.git")}`;
  const response = await requestDigest(emptyRoute);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.digest.total).toBe(0);
  expect(body.digest.byAge).toEqual({ fresh: 0, aging: 0, stale: 0 });
  expect(body.digest.items).toEqual([]);
  expect(body.previous).toBeNull();
});

it("recomputes on demand and reports the previous run", async () => {
  // A repo of its own: the digest is per repository, so the run history
  // asserted here cannot be disturbed by the other tests' submissions.
  const runRepo = "git@github.com:acme/digest-runs.git";
  const runRoute = `/agents/submission-review-agent/${encodeURIComponent(runRepo)}`;
  await submit(runRepo, "d".repeat(40), "feat: before the first run", hoursAgo(1));
  const firstBody = await (await requestDigest(runRoute)).json();
  expect(firstBody.digest.total).toBe(1);

  await submit(runRepo, "e".repeat(40), "feat: after the first run", hoursAgo(0));
  const secondBody = await (await requestDigest(runRoute)).json();
  expect(secondBody.digest.total).toBe(2);
  expect(secondBody.digest.items.map((item) => item.sha)).toContain("e".repeat(40));
  // The previous run is the first request's persisted digest: it predates
  // the second submission and stays frozen at its own computedAt.
  expect(secondBody.previous.total).toBe(1);
  expect(secondBody.previous.computedAt).toBe(firstBody.digest.computedAt);
  expect(secondBody.previous.items.map((item) => item.sha)).not.toContain("e".repeat(40));
});
