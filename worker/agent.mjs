// The SubmissionReviewAgent shell (ticket #31): one Durable Object
// instance per repository identity, keyed by the URL-carried instance
// name — percent-encoded, because repo remotes contain slashes. On request
// it fetches the repository's pending submissions through the existing D1
// binding, computes the digest with the pure runtime-free function, and
// persists each run in its own SQLite-backed storage so the next request
// can report the previous one (#32). Waking the agent arms the SDK's
// scheduler with one daily tick per repository (#33) — idempotent across
// wakes — so the backlog is measured even when nobody asks; a missed tick
// self-corrects on the next on-demand request, which recomputes from the
// current rows. The tick interval is a plain binding so the workerd suite
// can drive it at one second; production falls back to the daily default.
// Lives apart from ingest.mjs so the runtime-free suite never loads the
// Agents SDK.

import { Agent } from "agents";

import { computeDigest } from "./digest.mjs";

const PENDING_SUBMISSIONS =
  "SELECT commit_sha, subject, author, submitted_at FROM submissions WHERE repo_remote = ? AND status = 'pending'";

const LAST_DIGEST = "last-digest";
const DAY_SECONDS = 86_400;

export class SubmissionReviewAgent extends Agent {
  async onStart() {
    const override = Number(this.env?.DIGEST_TICK_INTERVAL_SECONDS);
    const intervalSeconds = Number.isInteger(override) && override > 0 ? override : DAY_SECONDS;
    await this.scheduleEvery(intervalSeconds, "digestTick");
  }

  async onRequest() {
    const repo = decodeURIComponent(this.name);
    const digest = await this.persistDigest(repo);
    return Response.json({ ok: true, repo, digest: digest.current, previous: digest.previous });
  }

  // The scheduler's named callback (#33): the same fetch, compute, and
  // persist as the on-demand path, with no request behind it.
  async digestTick() {
    await this.persistDigest(decodeURIComponent(this.name));
  }

  async persistDigest(repo) {
    const { results } = await this.env.D1_DB.prepare(PENDING_SUBMISSIONS).bind(repo).all();
    const current = computeDigest(results, new Date().toISOString());
    const previous = (await this.ctx.storage.get(LAST_DIGEST)) ?? null;
    await this.ctx.storage.put(LAST_DIGEST, current);
    return { current, previous };
  }
}
