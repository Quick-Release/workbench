import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { computeDigest } from "./digest.mjs";

// Rows carry the submissions table's shape, snake_case as D1 returns them;
// `now` is fixed so the digest is asserted byte-for-byte.

const NOW = "2026-09-07T12:00:00.000Z";

const row = (id, submittedAt, overrides = {}) => ({
  id,
  repo_remote: "git@github.com:acme/widgets.git",
  commit_sha: `e5a7f30c0e40a5d9b6b1c2f9a4d3e2b1a0c9d8e${id}`,
  subject: `feat: submission ${id}`,
  body: "What and why.",
  author: "Ada Lovelace",
  status: "pending",
  submitted_at: submittedAt,
  ...overrides,
});

const hoursAgo = (hours) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

test("digests pending rows into total, age buckets, and summary fields", () => {
  const digest = computeDigest(
    [
      row(1, hoursAgo(2)), // fresh
      row(2, hoursAgo(72)), // aging
      row(3, hoursAgo(24 * 30)), // stale
    ],
    NOW,
  );
  strictEqual(digest.total, 3);
  deepStrictEqual(digest.byAge, { fresh: 1, aging: 1, stale: 1 });
  strictEqual(digest.oldestAgeDays, 30);
  strictEqual(digest.computedAt, NOW);
  // The items list orders oldest first: the at-risk work reads first.
  deepStrictEqual(
    digest.items.map((item) => item.subject),
    ["feat: submission 3", "feat: submission 2", "feat: submission 1"],
  );
  strictEqual(digest.items[0].author, "Ada Lovelace");
  strictEqual(digest.items[0].ageDays, 30);
});

test("an empty pending set digests to zeros and no oldest", () => {
  const digest = computeDigest([], NOW);
  strictEqual(digest.total, 0);
  deepStrictEqual(digest.byAge, { fresh: 0, aging: 0, stale: 0 });
  strictEqual(digest.oldestAgeDays, null);
  deepStrictEqual(digest.items, []);
});

test("rows land on the bucket edges the contract defines", () => {
  const digest = computeDigest(
    [
      row(1, hoursAgo(23)), // just under a day: fresh
      row(2, hoursAgo(24)), // exactly one day: aging
      row(3, hoursAgo(24 * 7 - 1)), // just under a week: aging
      row(4, hoursAgo(24 * 7)), // exactly one week: stale
    ],
    NOW,
  );
  deepStrictEqual(digest.byAge, { fresh: 1, aging: 2, stale: 1 });
  strictEqual(digest.oldestAgeDays, 7);
});

test("rows sharing one repo identity count individually — no silent dedupe", () => {
  const digest = computeDigest(
    [
      row(1, hoursAgo(5), { commit_sha: "a".repeat(40) }),
      row(2, hoursAgo(6), { commit_sha: "b".repeat(40) }),
    ],
    NOW,
  );
  strictEqual(digest.total, 2);
  strictEqual(digest.items.length, 2);
});
