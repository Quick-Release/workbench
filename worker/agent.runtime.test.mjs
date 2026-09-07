import { applyD1Migrations, env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";

// The agent route's HTTP contract (tickets #31, #32, and #33), driven inside
// the real workerd runtime. The Agents SDK routes /agents/<agent>/<instance>
// to a Durable Object named by the URL — one instance per repository
// identity, carried percent-encoded because repo remotes contain slashes —
// but the route mounts strictly after the same constant-time bearer-token
// check that guards the ingest routes: agent endpoints are never a wider
// surface than the ingest API (ADR 0001). The digest itself is exercised
// through the real ingest path: submissions go in via POST /submissions,
// the agent reads them back through the same D1 binding production uses.
// The daily tick is exercised through the runtime's alarm invocation: the
// test binding runs the tick every second, so a forced alarm deterministically
// finds it due.

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

it("persists a digest on the scheduled tick without any request", async () => {
  // A repo of its own, so no other test's digest runs can masquerade as
  // this tick's. Waking the agent once through the authenticated route
  // arms the schedule; the tick itself then runs alarm-driven, with no
  // digest-serving request involved.
  const tickRepo = "git@github.com:acme/tick-runs.git";
  const tickRoute = `/agents/submission-review-agent/${encodeURIComponent(tickRepo)}`;
  const tickStub = env.SubmissionReviewAgent.get(
    env.SubmissionReviewAgent.idFromName(encodeURIComponent(tickRepo)),
  );

  await submit(tickRepo, "f0".repeat(20), "feat: before arming", hoursAgo(2));
  const armedBody = await (await requestDigest(tickRoute)).json();
  expect(armedBody.digest.total).toBe(1);

  // Past the one-second test interval, the forced alarm finds the tick due
  // and it persists the digest from the rows as they are now — a request
  // to the agent route is never made.
  await submit(tickRepo, "f1".repeat(20), "feat: before the tick", hoursAgo(1));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(await runDurableObjectAlarm(tickStub)).toBe(true);

  const nextBody = await (await requestDigest(tickRoute)).json();
  expect(nextBody.digest.total).toBe(2);
  // The only run persisted between the two requests was the tick's: its
  // digest already counted the second submission.
  expect(nextBody.previous.total).toBe(2);
  expect(nextBody.previous.computedAt).not.toBe(armedBody.digest.computedAt);
});

it("recomputes on demand after a missed tick", async () => {
  // The scheduler is an optimization, never a correctness dependency: with
  // the schedule armed but the tick not fired, the on-demand request still
  // computes from the current pending rows.
  const missedRepo = "git@github.com:acme/missed-ticks.git";
  const missedRoute = `/agents/submission-review-agent/${encodeURIComponent(missedRepo)}`;
  await submit(missedRepo, "f2".repeat(20), "feat: at arming", hoursAgo(2));
  const armedBody = await (await requestDigest(missedRoute)).json();
  expect(armedBody.digest.total).toBe(1);

  await submit(missedRepo, "f3".repeat(20), "feat: after arming, unticked", hoursAgo(1));
  const body = await (await requestDigest(missedRoute)).json();
  expect(body.digest.total).toBe(2);
  expect(body.previous.total).toBe(1);
});

it("answers 405 for non-GET methods on the digest route", async () => {
  // Computing and persisting a digest is a read: a POST must not trigger a
  // run, so the route answers method-not-allowed instead.
  const methodRepo = `/agents/submission-review-agent/${encodeURIComponent("git@github.com:acme/methods.git")}`;
  const response = await SELF.fetch(`https://example.com${methodRepo}`, {
    method: "POST",
    headers: { Authorization: "Bearer test-ingest-token" },
  });
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET");
  expect(await response.json()).toEqual({ ok: false, error: "method not allowed" });
});

it("answers 400 for a malformed repository identity", async () => {
  // A percent-encoded segment that does not decode names no repository;
  // it must be a client error, not an unhandled 500 behind the gate.
  const response = await SELF.fetch("https://example.com/agents/submission-review-agent/%zz", {
    headers: { Authorization: "Bearer test-ingest-token" },
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: "malformed repository identity" });
});

it("serializes concurrent digest runs into one previous-run chain", async () => {
  // Input gates do not span the D1 round-trip, so unsynchronized concurrent
  // runs can all observe an empty history and persist out of order. The
  // runs must land one at a time: exactly the first has no predecessor, and
  // every later run's previous is the run just before it.
  const raceRepo = "git@github.com:acme/race-serialization.git";
  const raceRoute = `/agents/submission-review-agent/${encodeURIComponent(raceRepo)}`;
  await submit(raceRepo, "f4".repeat(20), "feat: one pending row", hoursAgo(1));

  const bodies = await Promise.all(
    Array.from({ length: 6 }, () => requestDigest(raceRoute).then((r) => r.json())),
  );
  for (const body of bodies) expect(body.digest.total).toBe(1);

  const byTime = [...bodies].sort((left, right) =>
    left.digest.computedAt < right.digest.computedAt ? -1 : 1,
  );
  expect(byTime[0].previous).toBeNull();
  for (let i = 1; i < byTime.length; i++) {
    expect(byTime[i].previous.total).toBe(1);
    expect(byTime[i].previous.computedAt).toBe(byTime[i - 1].digest.computedAt);
  }
});
