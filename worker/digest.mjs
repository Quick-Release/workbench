// The digest a maintainer consumes, as a pure function of the
// pending-submission rows (ticket #30, the compute step of spec #28's
// SubmissionReviewAgent). No runtime, no clock: `now` is an argument, so the
// output is deterministic and this shape is the stable contract a future AI
// summarizer plugs into. Rows carry the submissions table's shape as D1
// returns it.

const DAY_MS = 86_400_000;

// The aging buckets the digest speaks: fresh work can still wait its turn,
// aging work should be reviewed this week, stale work is at risk of being
// forgotten. Exactly one day old is aging; exactly one week old is stale.
const BUCKETS = [
  ["fresh", (ageDays) => ageDays < 1],
  ["aging", (ageDays) => ageDays < 7],
  ["stale", () => true],
];

const ageInDays = (submittedAt, nowMs) => Math.floor((nowMs - Date.parse(submittedAt)) / DAY_MS);

export const computeDigest = (pendingSubmissions, now) => {
  const nowMs = Date.parse(now);
  const items = pendingSubmissions
    .map((entry) => ({
      sha: entry.commit_sha,
      subject: entry.subject,
      author: entry.author,
      ageDays: Math.max(0, ageInDays(entry.submitted_at, nowMs)),
    }))
    .sort((left, right) => right.ageDays - left.ageDays);

  const byAge = Object.fromEntries(BUCKETS.map(([name]) => [name, 0]));
  for (const item of items) {
    for (const [name, matches] of BUCKETS) {
      if (matches(item.ageDays)) {
        byAge[name] += 1;
        break;
      }
    }
  }

  return {
    total: items.length,
    byAge,
    oldestAgeDays: items.length > 0 ? items[0].ageDays : null,
    computedAt: new Date(now).toISOString(),
    items,
  };
};
