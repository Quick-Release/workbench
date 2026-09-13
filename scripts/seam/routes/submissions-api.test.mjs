import { deepStrictEqual, match, strictEqual } from "node:assert";
import test from "node:test";

import { handleSubmissionsApi } from "./submissions-api.mjs";

// The Submission seam (ticket #12, user stories 16-21): the Highlights
// page's Submit action POSTs to this dev-server endpoint, which attaches
// the host repo remote and the ingest token server-side and forwards to
// the Worker's /submissions ingest. The browser never holds a credential.
// The worker client is injected, so tests stub it entirely.

const localhost = { host: "localhost:4051", origin: "http://localhost:4051" };

const candidate = {
  sha: "e5a7f30c0e40a5d9b6b1c2f9a4d3e2b1a0c9d8e7",
  subject: "feat: dedupe table chrome",
  body: "Extracts the shared table header. Refs: #11",
  author: "Ada Lovelace",
  ticketRef: "#11",
};

const handler = (overrides = {}) =>
  handleSubmissionsApi({
    method: "POST",
    pathname: "/api/submissions",
    body: JSON.stringify(candidate),
    ...localhost,
    repoRemote: "git@github.com:acme/widgets.git",
    workerFetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ...overrides,
  });

test("forwards the submission with repo remote and timestamp attached", async () => {
  const forwards = [];
  const handled = await handler({
    workerFetch: async (path, init) => {
      forwards.push({ path, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  strictEqual(handled.status, 200);
  deepStrictEqual(handled.json, { ok: true });
  strictEqual(forwards.length, 1);
  strictEqual(forwards[0].path, "/submissions");
  const payload = JSON.parse(forwards[0].init.body);
  strictEqual(payload.repoRemote, "git@github.com:acme/widgets.git");
  strictEqual(payload.commitSha, candidate.sha);
  strictEqual(payload.subject, candidate.subject);
  strictEqual(payload.author, candidate.author);
  match(payload.submittedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("relays the worker's duplicate verdict verbatim", async () => {
  const handled = await handler({
    workerFetch: async () =>
      new Response(JSON.stringify({ ok: false, error: "duplicate: already received" }), {
        status: 409,
      }),
  });
  strictEqual(handled.status, 409);
  match(handled.json.error, /duplicate/);
});

test("rejects a candidate missing its commit sha", async () => {
  const handled = await handler({
    body: JSON.stringify({ ...candidate, sha: "" }),
  });
  strictEqual(handled.status, 400);
  match(handled.json.message, /sha/);
});

test("answers the gate, the method check, and the unconfigured worker", async () => {
  strictEqual((await handler({ origin: "https://evil.example" })).status, 403);
  strictEqual((await handler({ method: "GET" })).status, 405);
  const unconfigured = await handler({ workerFetch: null });
  strictEqual(unconfigured.status, 503);
  strictEqual(unconfigured.json.error, "not_configured");
});
