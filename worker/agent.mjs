// The SubmissionReviewAgent shell (ticket #31): one Durable Object
// instance per repository identity, keyed by the URL-carried instance
// name — percent-encoded, because repo remotes contain slashes. On request
// it fetches the repository's pending submissions through the existing D1
// binding, computes the digest with the pure runtime-free function, and
// persists each run in its own SQLite-backed storage so the next request
// can report the previous one (ticket #32). Lives apart from ingest.mjs so
// the runtime-free suite never loads the Agents SDK.

import { Agent } from "agents";

import { computeDigest } from "./digest.mjs";

const PENDING_SUBMISSIONS =
  "SELECT commit_sha, subject, author, submitted_at FROM submissions WHERE repo_remote = ? AND status = 'pending'";

const LAST_DIGEST = "last-digest";

export class SubmissionReviewAgent extends Agent {
  async onRequest() {
    const repo = decodeURIComponent(this.name);
    const { results } = await this.env.D1_DB.prepare(PENDING_SUBMISSIONS).bind(repo).all();
    const digest = computeDigest(results, new Date().toISOString());
    const previous = (await this.ctx.storage.get(LAST_DIGEST)) ?? null;
    await this.ctx.storage.put(LAST_DIGEST, digest);
    return Response.json({ ok: true, repo, digest, previous });
  }
}
