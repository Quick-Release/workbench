// The SubmissionReviewAgent shell (ticket #31): one Durable Object
// instance per repository identity, keyed by the URL-carried instance
// name — percent-encoded, because repo remotes contain slashes. The
// digest computation plugs in at this seam in #32; for now the agent
// proves it answered through the authenticated route. Lives apart from
// ingest.mjs so the runtime-free suite never loads the Agents SDK.

import { Agent } from "agents";

export class SubmissionReviewAgent extends Agent {
  async onRequest() {
    return Response.json({
      ok: true,
      agent: "submission-review-agent",
      repo: decodeURIComponent(this.name),
    });
  }
}
