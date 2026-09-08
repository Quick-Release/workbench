import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, expect, it } from "vite-plus/test";

import { submissionOutcomeFromResponse, submitHighlight } from "./submissions";
import type { CommitCandidate } from "../types";
import type { HighlightCandidateInput } from "./submissions";

// The Submission client (ticket #12): the one module-boundary mock in the
// suite — the browser-side POST to the localhost seam, mapped to the
// consent outcomes the page renders.

const candidate: HighlightCandidateInput = {
  sha: "e5a7f30c0e40a5d9b6b1c2f9a4d3e2b1a0c9d8e7",
  subject: "feat: dedupe table chrome",
  body: "Extracts the shared table header. Refs: #11",
  author: "Ada Lovelace",
  ticketRef: "#11",
};

const jsonResponse = (body: { ok?: boolean; error?: string }, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("submitHighlight", () => {
  it("POSTs the candidate to the localhost seam", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await submitHighlight(candidate, async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    });
    deepStrictEqual(outcome, {
      status: "submitted",
      message: "Submitted — thank you! It is in the review queue.",
    });
    strictEqual(calls[0].url, "/api/submissions");
    strictEqual(calls[0].init.method, "POST");
    deepStrictEqual(JSON.parse(String(calls[0].init.body)), candidate);
  });

  it("sends only the schema's fields when handed a richer candidate", async () => {
    // The route passes the page's CommitCandidate, which carries the display
    // date; the seam's schema rejects excess properties, so the wire body is
    // pinned to the client contract whatever the input carries.
    const richer: CommitCandidate = { ...candidate, date: "2026-09-03T10:00:00.000Z" };
    const bodies: string[] = [];
    await submitHighlight(richer, async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return jsonResponse({ ok: true });
    });
    deepStrictEqual(JSON.parse(bodies[0]), candidate);
  });

  it("maps a duplicate to its own outcome", async () => {
    const outcome = await submitHighlight(candidate, async () =>
      jsonResponse({ ok: false, error: "duplicate: already received" }, 409),
    );
    strictEqual(outcome.status, "duplicate");
    expect(outcome.message).toContain("already submitted");
  });

  it("maps a failure to a failed outcome with the server's message", async () => {
    const outcome = await submitHighlight(candidate, async () =>
      jsonResponse({ ok: false, error: "storage failure" }, 500),
    );
    deepStrictEqual(outcome, { status: "failed", message: "storage failure" });
  });
});

describe("submissionOutcomeFromResponse", () => {
  it("is the single response-to-outcome mapping", () => {
    deepStrictEqual(submissionOutcomeFromResponse(200, { ok: true }), {
      status: "submitted",
      message: "Submitted — thank you! It is in the review queue.",
    });
    const duplicate = submissionOutcomeFromResponse(409, {
      ok: false,
      error: "duplicate: already received",
    });
    strictEqual(duplicate.status, "duplicate");
    const failed = submissionOutcomeFromResponse(500, { ok: false, error: "storage failure" });
    deepStrictEqual(failed, { status: "failed", message: "storage failure" });
    strictEqual(submissionOutcomeFromResponse(500, {}).status, "failed");
  });
});
