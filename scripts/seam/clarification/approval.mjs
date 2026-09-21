import { createHash } from "node:crypto";

import { CONTEXT_PACKET_VERSION, canonicalJson } from "./context-packet.mjs";
import { DRAFT_ENVELOPE_VERSION } from "./draft.mjs";
import { EVENT_ENVELOPE_VERSION } from "./store.mjs";
import { FAILURE_POLICY_VERSION } from "./failures.mjs";

// The approval binding and the issue-body publication contract (spec #221,
// ticket #234, ADR 0014): the one tracker write Owned clarification has.
//
// The binding is the full approval: host and issue identity with revision,
// provider and data destination, context digest, capability set, policy and
// contract versions, and the digest of the exact bytes publication writes —
// the visible diff's "after", with the revision pinning its "before". A
// material change to any of it makes a pending approval stale; nothing
// here interprets tracker content as instruction (ADR 0016).

export const APPROVAL_BINDING_VERSION = "clarification-approval/v1";

// The one action an approval of the brief authorizes: the issue-body write
// and nothing else — no labels, no tickets, no other tracker surface.
export const PUBLICATION_ACTION = "publish-issue-body";

// The publication attempt's outcome kinds: published (proven by read-back),
// a known failure with its named reason, or an Unknown outcome that demands
// reconciliation before anything retries.
export const PUBLICATION_RESULTS = ["published", "publication-failed", "publication-unknown"];

// The named known-failure reasons. `write-refused` proves the tracker saw
// and declined the write; the read-back reasons say the write was delivered
// but could not be proven — the tracker now serves something else, or
// serves nothing readable.
export const PUBLICATION_FAILURE_REASONS = [
  "write-refused",
  "read-back-mismatch",
  "read-back-unavailable",
];

const CONTRACT_VERSIONS = Object.freeze({
  approval: APPROVAL_BINDING_VERSION,
  draft: DRAFT_ENVELOPE_VERSION,
  contextPacket: CONTEXT_PACKET_VERSION,
  events: EVENT_ENVELOPE_VERSION,
  failurePolicy: FAILURE_POLICY_VERSION,
});

const approvalError = (code, message) => Object.assign(new Error(message), { code });

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

const isDigest = (value) => typeof value === "string" && value.startsWith("sha-256:");

// The binding's fields, defined once: the validator refuses a binding with
// missing facts or fields the contract never declared — an approval that
// cannot say exactly what it covers is not an approval.
const BINDING_FIELDS = [
  "version",
  "host",
  "issue",
  "provider",
  "dataDestination",
  "contextDigest",
  "bodyDigest",
  "capabilitySet",
  "action",
  "contractVersions",
];

// The binding's shape gate. Assembly validates its own product with this
// and refuses to build anything less — the binding's shape is this
// module's contract, not the store's; an approval is only as good as the
// facts it pins.
export const validateApprovalBinding = (binding) => {
  const reasons = [];
  if (!isPlainObject(binding)) return approvalError("invalid_binding", "a binding is an object");
  if (binding.version !== APPROVAL_BINDING_VERSION)
    reasons.push(`the binding's version must be ${APPROVAL_BINDING_VERSION}`);
  if (!isNonEmptyString(binding.host)) reasons.push("the binding names no host repository");
  if (!isPlainObject(binding.issue)) {
    reasons.push("the binding names no issue");
  } else {
    if (!Number.isInteger(binding.issue.number) || binding.issue.number <= 0)
      reasons.push("the binding's issue number is not a positive integer");
    if (!isNonEmptyString(binding.issue.issueId)) reasons.push("the binding carries no issue id");
    if (
      !isPlainObject(binding.issue.revision) ||
      !isNonEmptyString(binding.issue.revision.updatedAt) ||
      !isDigest(binding.issue.revision.bodyHash)
    )
      reasons.push("the binding pins no issue revision (updatedAt and bodyHash)");
  }
  if (!isNonEmptyString(binding.provider)) reasons.push("the binding names no provider");
  if (!isNonEmptyString(binding.dataDestination))
    reasons.push("the binding names no data destination");
  if (!isDigest(binding.contextDigest)) reasons.push("the binding carries no context digest");
  if (!isDigest(binding.bodyDigest))
    reasons.push("the binding carries no digest of the exact body it publishes");
  if (
    !Array.isArray(binding.capabilitySet) ||
    binding.capabilitySet.length === 0 ||
    binding.capabilitySet.some((entry) => !isNonEmptyString(entry))
  )
    reasons.push("the binding's capability set is a non-empty list of strings");
  if (binding.action !== PUBLICATION_ACTION)
    reasons.push(`the binding's action must be ${PUBLICATION_ACTION}`);
  if (!isPlainObject(binding.contractVersions)) {
    reasons.push("the binding carries no contract versions");
  } else {
    for (const [name, version] of Object.entries(CONTRACT_VERSIONS))
      if (binding.contractVersions[name] !== version)
        reasons.push(`the binding's ${name} contract version must be ${version}`);
    for (const key of Object.keys(binding.contractVersions))
      if (!(key in CONTRACT_VERSIONS))
        reasons.push(`"${key}" is not a contract version of an approval binding`);
  }
  for (const key of Object.keys(binding))
    if (!BINDING_FIELDS.includes(key))
      reasons.push(`"${key}" is not a field of an approval binding`);
  if (reasons.length > 0)
    throw approvalError(
      "invalid_binding",
      `this is not an approval binding (${reasons.join("; ")})`,
    );
  return binding;
};

// The digest of the exact bytes publication writes: the visible diff's
// "after", pinned so approval, display and publication can never disagree
// about what lands on the issue.
export const bodyDigestFor = (body) => `sha-256:${createHash("sha256").update(body).digest("hex")}`;

// The pre-write gate: one pending approval against freshly gathered
// evidence, immediately before the tracker write. The order is the fence's
// order — a spent or dead approval is told so before anything else is
// checked (it must never reopen whatever else moved); expiry next; then the
// two material comparisons, the issue revision and the wider context
// digest. Refusals carry the reason; the write they blocked never happens.
export const approvalGateFor = ({ approval, now, freshRevision, freshContextDigest }) => {
  const refuse = (code, message) => ({ ok: false, code, message });
  if (approval.status !== "pending")
    return refuse(
      "approval_used",
      approval.status === "stale"
        ? "this approval already went stale and can never publish"
        : "this approval is single-use and has already been spent",
    );
  if (Date.parse(approval.expiresAt) <= Date.parse(now))
    return refuse(
      "approval_expired",
      `the approval expired at ${approval.expiresAt} — approve the current diff again`,
    );
  const pinned = approval.binding.issue.revision;
  if (pinned.updatedAt !== freshRevision.updatedAt || pinned.bodyHash !== freshRevision.bodyHash)
    return refuse(
      "approval_stale",
      `the issue moved past the revision the approval pins (${pinned.updatedAt}, ${pinned.bodyHash}) — a concurrent edit blocks the write; approve the fresh diff again`,
    );
  if (approval.binding.contextDigest !== freshContextDigest)
    return refuse(
      "approval_stale",
      "the issue's material context changed since the approval — a new attempt assembles fresh evidence",
    );
  return { ok: true };
};

// The tracker write adapter (ADR 0016's credential boundary): one PATCH of
// the issue body, the host's own credentials attached and never traveling
// further. The request body carries the body field and NOTHING else — the
// transport-level shape of "labels, tickets, and every other tracker
// surface stay untouched". A 2xx resolves delivered; a 4xx is a definite
// refusal (typed `publication-write-refused` — the tracker saw and refused
// the write); everything else — a 5xx, a network failure — refuses to
// claim either way: the caller treats it as an uncertain write, because a
// fetch that throws may still have been sent.
const API_VERSION = "2022-11-28";

export const publishIssueBodyViaRest = async ({
  repo,
  issueNumber,
  body,
  token,
  apiBase = "https://api.github.com",
  fetchImpl = fetch,
}) => {
  const url = new URL(`${apiBase}/repos/${repo}/issues/${issueNumber}`);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ body }),
    });
  } catch (error) {
    throw new Error(`the issue-body write could not be delivered (${String(error)})`);
  }
  if (response.ok) return { delivered: true };
  if (response.status >= 400 && response.status < 500) {
    throw Object.assign(
      new Error(`the tracker refused the issue-body write (HTTP ${response.status})`),
      { code: "publication-write-refused", status: response.status },
    );
  }
  throw new Error(
    `the issue-body write ended in an uncertain tracker response (HTTP ${response.status})`,
  );
};

// The approval's context identity: a digest over the material facts of one
// collected tracker read — which repository, which issue, at which revision,
// with which planning records in which states. Deliberately deaf to the
// read's own housekeeping (retrieval times, warnings, provenance bookkeeping):
// those are evidence ABOUT the context, not the context the approval covers.
// A different digest here is a material change — the pending approval is
// stale and a new attempt assembles fresh evidence, never an edit in place.
export const contextDigestFor = (collected) =>
  `sha-256:${createHash("sha256")
    .update(
      canonicalJson({
        repo: collected.repo,
        issue: {
          number: collected.issue.number,
          title: collected.issue.title,
          state: collected.issue.state,
        },
        revision: collected.revision,
        blockers: collected.blockers.map((record) => ({
          number: record.number,
          title: record.title,
          state: record.state,
        })),
      }),
    )
    .digest("hex")}`;

// The full approval binding: every fact the Developer's explicit approval
// covers, frozen so a recorded binding cannot be edited in place. The
// capability set arrives from the caller (the manifest's summary plus the
// publication action this approval grants); the contract versions are the
// modules' own, not arguments — a binding never travels under versions it
// did not declare.
export const buildApprovalBinding = ({
  host,
  issueNumber,
  issueId,
  revision,
  bodyDigest,
  provider,
  dataDestination,
  contextDigest,
  capabilitySet,
}) =>
  Object.freeze(
    validateApprovalBinding({
      version: APPROVAL_BINDING_VERSION,
      host,
      issue: { number: issueNumber, issueId, revision: { ...revision } },
      provider,
      dataDestination,
      contextDigest,
      bodyDigest,
      capabilitySet: Object.freeze([...capabilitySet]),
      action: PUBLICATION_ACTION,
      contractVersions: { ...CONTRACT_VERSIONS },
    }),
  );
