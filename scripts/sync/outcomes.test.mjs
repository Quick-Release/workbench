import { strictEqual } from "node:assert";
import test from "node:test";

import { fetchOutcomes, isGitHubRemote } from "./outcomes.mjs";

// The Outcomes adapter (ticket #16): the identified Developer's pull
// requests on the host repo over a rolling 30 days — opened, merged, and
// median time-to-merge — for the Telemetry payload. GitHub responses are
// stubbed; non-GitHub remotes report no Outcomes.

const pr = (n, { author = "ada", created = "2026-09-01T00:00:00Z", mergedAt = null } = {}) => ({
  number: n,
  user: { login: author },
  created_at: created,
  merged_at: mergedAt,
});

const jsonResponse = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("a GitHub remote is recognized; others are not", () => {
  strictEqual(isGitHubRemote("https://github.com/acme/widgets"), true);
  strictEqual(isGitHubRemote("git@github.com:acme/widgets.git"), true);
  strictEqual(isGitHubRemote("https://gitlab.com/acme/widgets"), false);
  strictEqual(isGitHubRemote("not a url"), false);
});

test("computes opened, merged, and median time-to-merge for the developer", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse([
      pr(1, { created: "2026-09-05T00:00:00Z", mergedAt: "2026-09-06T00:00:00Z" }),
      pr(2, { created: "2026-09-07T00:00:00Z", mergedAt: "2026-09-08T12:00:00Z" }),
      pr(3, { created: "2026-09-07T00:00:00Z" }),
      pr(4, { author: "grace", created: "2026-09-07T00:00:00Z", mergedAt: "2026-09-08T00:00:00Z" }),
    ]);
  };
  const outcomes = await fetchOutcomes({
    repositoryUrl: "https://github.com/acme/widgets",
    login: "ada",
    token: "t",
    fetchImpl,
    now: new Date("2026-09-08T23:00:00Z"),
  });
  strictEqual(outcomes.opened, 3);
  strictEqual(outcomes.merged, 2);
  // One day (86,400,000 ms) and 1.5 days; median is the average.
  strictEqual(outcomes.medianTimeToMergeMs, (86_400_000 + 129_600_000) / 2);
  strictEqual(
    calls[0].url,
    "https://api.github.com/repos/acme/widgets/pulls?state=all&sort=created&direction=desc&per_page=100",
  );
  strictEqual(calls[0].init.headers.Authorization, "Bearer t");
});

test("only the rolling 30-day window counts", async () => {
  const fetchImpl = async () =>
    jsonResponse([
      pr(1, { created: "2026-09-07T00:00:00Z" }),
      pr(2, { created: "2026-05-01T00:00:00Z" }),
      pr(3, { created: "2026-05-02T00:00:00Z", mergedAt: "2026-05-03T00:00:00Z" }),
    ]);
  const outcomes = await fetchOutcomes({
    repositoryUrl: "https://github.com/acme/widgets",
    login: "ada",
    token: "t",
    fetchImpl,
    now: new Date("2026-09-08T23:00:00Z"),
  });
  strictEqual(outcomes.opened, 1);
  strictEqual(outcomes.merged, 0);
  strictEqual(outcomes.medianTimeToMergeMs, null);
});

test("a non-GitHub remote reports no outcomes", async () => {
  const { outcomesForRepository } = await import("./outcomes.mjs");
  strictEqual(
    await outcomesForRepository({ repositoryUrl: "https://gitlab.com/acme/widgets", login: "ada" }),
    undefined,
  );
});
