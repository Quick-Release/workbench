import { deepStrictEqual, ok, strictEqual } from "node:assert";
import test from "node:test";

import {
  PUBLICATION_FAILURE_REASONS,
  PUBLICATION_RESULTS,
  approvalGateFor,
  bodyDigestFor,
  buildApprovalBinding,
  contextDigestFor,
  publishIssueBodyViaRest,
} from "./approval.mjs";
import {
  clarificationPublicationFailureReasons,
  clarificationPublicationResults,
} from "../../../src/types.ts";

// Contract tests for the approval binding and issue-body publication
// contract (spec #221, ticket #234, ADR 0014): the binding's full shape,
// the digests that make "the exact diff" and "the same context" checkable,
// the gate arithmetic that stands between a pending approval and the one
// tracker write, and the write adapter's narrow surface. Pure arithmetic
// and an injected transport — no real tracker below these tests.

test("an approval binding carries every fact the Developer's approval covers", () => {
  const binding = buildApprovalBinding({
    host: "Quick-Release/workbench",
    issueNumber: 230,
    issueId: "230",
    revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
    bodyDigest: "sha-256:def",
    provider: "openai-codex-oauth",
    dataDestination: "https://api.openai.com",
    contextDigest: "sha-256:123",
    capabilitySet: [
      "reads the pinned issue and its related planning records",
      "publishes the approved issue body",
    ],
  });

  deepStrictEqual(binding, {
    version: "clarification-approval/v1",
    host: "Quick-Release/workbench",
    issue: {
      number: 230,
      issueId: "230",
      revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
    },
    provider: "openai-codex-oauth",
    dataDestination: "https://api.openai.com",
    contextDigest: "sha-256:123",
    bodyDigest: "sha-256:def",
    capabilitySet: [
      "reads the pinned issue and its related planning records",
      "publishes the approved issue body",
    ],
    action: "publish-issue-body",
    contractVersions: {
      approval: "clarification-approval/v1",
      draft: "clarification-draft/v1",
      contextPacket: "context-packet/v1",
      events: "clarification-events/v1",
      failurePolicy: "clarification-failure-policy/v1",
    },
  });
});

// A collected tracker read shaped like collectTrackerContext's result; the
// retrieval timestamps ride along so the tests can prove the digest ignores
// them — the material facts are what an approval binds to, never the read's
// own housekeeping.
const collected = (overrides = {}) => ({
  repo: "Quick-Release/workbench",
  issue: { number: 230, title: "Clarification 09", body: "the body", state: "OPEN" },
  revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
  issueProvenance: { source: "tracker", locator: "Quick-Release/workbench#230" },
  blockers: [],
  warnings: [],
  capped: false,
  failed: false,
  ...overrides,
});

test("the context digest is stable over one material context and deaf to read housekeeping", () => {
  const first = contextDigestFor(
    collected({
      issueProvenance: { retrievedAt: "2026-09-18T10:00:00.000Z" },
      warnings: ["a coverage warning"],
    }),
  );
  const second = contextDigestFor(
    collected({ issueProvenance: { retrievedAt: "2026-09-19T23:59:59.000Z" } }),
  );
  strictEqual(first, second);
  ok(first.startsWith("sha-256:"));
});

test("a material context change is a different digest; trivia is not", () => {
  const base = contextDigestFor(collected());
  ok(contextDigestFor(collected({ repo: "Other/project" })) !== base, "another repo");
  ok(
    contextDigestFor(
      collected({ revision: { updatedAt: "2026-09-18T11:00:00.000Z", bodyHash: "sha-256:abc" } }),
    ) !== base,
    "a moved revision",
  );
  ok(
    contextDigestFor(
      collected({ revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:zzz" } }),
    ) !== base,
    "a changed body",
  );
  ok(
    contextDigestFor(
      collected({ issue: { number: 230, title: "Renamed", body: "the body", state: "OPEN" } }),
    ) !== base,
    "a renamed issue",
  );
  ok(
    contextDigestFor(
      collected({
        blockers: [
          {
            number: 12,
            title: "a blocker",
            state: "OPEN",
            provenance: { source: "tracker", locator: "x" },
          },
        ],
      }),
    ) !== base,
    "a blocker gained",
  );
  ok(
    contextDigestFor(
      collected({
        blockers: [
          {
            number: 12,
            title: "a blocker",
            state: "CLOSED",
            provenance: { source: "tracker", locator: "x" },
          },
        ],
      }),
    ) !==
      contextDigestFor(
        collected({ blockers: [{ number: 12, title: "a blocker", state: "OPEN" }] }),
      ),
    "a blocker closed",
  );
});

test("the body digest is the sha-256 of the exact bytes publication writes", () => {
  // The well-known sha-256 of the empty string: an independent literal, so
  // the digest is checked against reality, not against itself.
  strictEqual(
    bodyDigestFor(""),
    "sha-256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  ok(bodyDigestFor("different bytes") !== bodyDigestFor(""));
});

// The gate's fixtures: one recorded binding and the fresh evidence the
// pre-write check gathers. `fresh` matches the binding in every dimension;
// each staleness test moves exactly one thing.
const binding = buildApprovalBinding({
  host: "Quick-Release/workbench",
  issueNumber: 230,
  issueId: "230",
  revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
  bodyDigest: "sha-256:def",
  provider: "openai-codex-oauth",
  dataDestination: "https://api.openai.com",
  contextDigest: "sha-256:123",
  capabilitySet: ["publishes the approved issue body"],
});
const freshEvidence = {
  freshRevision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
  freshContextDigest: "sha-256:123",
};
const gate = (overrides = {}) =>
  approvalGateFor({
    approval: { status: "pending", expiresAt: "2026-09-18T10:05:00.000Z", binding },
    now: "2026-09-18T10:00:30.000Z",
    ...freshEvidence,
    ...overrides,
  });

test("a pending, unexpired approval over unchanged reality opens the gate", () => {
  const verdict = gate();
  strictEqual(verdict.ok, true);
});

test("an approval that is not pending never opens the gate, whatever reality says", () => {
  strictEqual(
    gate({ approval: { status: "consumed", expiresAt: "2026-09-18T10:05:00.000Z", binding } }).ok,
    false,
  );
  strictEqual(
    gate({ approval: { status: "stale", expiresAt: "2026-09-18T10:05:00.000Z", binding } }).ok,
    false,
  );
  const consumed = gate({
    approval: { status: "consumed", expiresAt: "2026-09-18T10:05:00.000Z", binding },
  });
  strictEqual(consumed.code, "approval_used");
});

test("an expired approval is dead even over unchanged reality", () => {
  const verdict = gate({
    approval: { status: "pending", expiresAt: "2026-09-18T10:00:00.000Z", binding },
    now: "2026-09-18T10:00:00.000Z",
  });
  strictEqual(verdict.ok, false);
  strictEqual(verdict.code, "approval_expired");
});

test("a concurrent edit to the issue makes the pending approval stale and blocks the write", () => {
  const verdict = gate({
    freshRevision: { updatedAt: "2026-09-18T10:00:45.000Z", bodyHash: "sha-256:other" },
  });
  strictEqual(verdict.ok, false);
  strictEqual(verdict.code, "approval_stale");
  ok(verdict.message.includes("revision"));
});

test("a material context change under the same revision is stale too", () => {
  const verdict = gate({ freshContextDigest: "sha-256:moved" });
  strictEqual(verdict.ok, false);
  strictEqual(verdict.code, "approval_stale");
  ok(verdict.message.includes("context"));
});

// The write adapter's transport: a captured fetch with a scriptable status.
const fetchWriting =
  (status, calls = []) =>
  async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status };
  };

test("the write adapter patches exactly the issue body and nothing else", async () => {
  const calls = [];
  const result = await publishIssueBodyViaRest({
    repo: "Quick-Release/workbench",
    issueNumber: 230,
    body: "the approved brief",
    token: "host-token",
    fetchImpl: fetchWriting(200, calls),
  });
  strictEqual(result.delivered, true);
  strictEqual(calls.length, 1);
  strictEqual(calls[0].url, "https://api.github.com/repos/Quick-Release/workbench/issues/230");
  strictEqual(calls[0].init.method, "PATCH");
  // The one write this capability has touches one field: no labels, no
  // tickets, no state, no assignees — the request body carries the issue
  // body and is otherwise empty.
  deepStrictEqual(JSON.parse(calls[0].init.body), { body: "the approved brief" });
  strictEqual(calls[0].init.headers.Authorization, "Bearer host-token");
});

test("a definite tracker refusal is a typed refusal, not an unknown", async () => {
  const error = await publishIssueBodyViaRest({
    repo: "Quick-Release/workbench",
    issueNumber: 230,
    body: "the approved brief",
    token: "host-token",
    fetchImpl: fetchWriting(422),
  }).then(
    () => null,
    (e) => e,
  );
  ok(error !== null);
  strictEqual(error.code, "publication-write-refused");
});

test("an ambiguous write — server error or network failure — refuses to claim a refusal", async () => {
  const ambiguous = async (fetchImpl) =>
    publishIssueBodyViaRest({
      repo: "Quick-Release/workbench",
      issueNumber: 230,
      body: "the approved brief",
      token: "host-token",
      fetchImpl,
    }).then(
      () => "delivered",
      (e) => e.code ?? "plain-error",
    );
  strictEqual(await ambiguous(fetchWriting(500)), "plain-error");
  strictEqual(
    await ambiguous(async () => {
      throw new TypeError("fetch failed");
    }),
    "plain-error",
  );
});

test("the publication outcome vocabulary never drifts from the seam's", () => {
  deepStrictEqual([...PUBLICATION_RESULTS], [...clarificationPublicationResults]);
  deepStrictEqual([...PUBLICATION_FAILURE_REASONS], [...clarificationPublicationFailureReasons]);
});
