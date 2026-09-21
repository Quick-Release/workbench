import { createHash } from "node:crypto";

// The Workbench-owned failure policy (spec #221, ticket #235, ADR 0023):
// outcomes carry a classification — known failure, unsupported, policy
// denial, cancellation, Unknown outcome — and every classification maps to
// exactly one bounded permitted next action. The module is pure and total
// over its closed vocabularies: an outcome outside them is a typed
// rejection, never a guess, because a misclassified failure is exactly how
// a silent retry or an invented success slips in.
//
// The mapping, in full:
//
//   provider-failure   → known-failure, park awaiting-human (quota, auth —
//                        nothing retries, falls back, or overruns; the
//                        usage the provider reported is preserved verbatim)
//   rejected           → known-failure, terminal, the Developer's manual
//                        fresh attempt is the only continuation
//   start-denied       → known-failure or unsupported (see below), terminal,
//                        the one outcome kind that PROVES no provider or
//                        tool dispatch occurred — the adapter's start
//                        denials all fire before a prompt can exist
//   policy-denied      → policy-denial, terminal, manual fresh attempt
//   cancelled          → cancellation, terminal, manual fresh attempt
//   unknown            → Unknown outcome, reconcile — uncertainty is never
//                        retried as if nothing happened
//
// After dispatch, every retry is the Developer's manual fresh attempt on a
// re-rendered manifest. The one coordinator retry is gated elsewhere on the
// durable non-dispatch proof this module defines.

// The policy's own contract version: approvals bind to the version of the
// policy that will classify their publication's outcomes (ticket #234), so
// a binding written under one policy never silently travels under another.
export const FAILURE_POLICY_VERSION = "clarification-failure-policy/v1";

export const FAILURE_CLASSIFICATIONS = [
  "known-failure",
  "unsupported",
  "policy-denial",
  "cancellation",
  "unknown",
];

// What may happen next, in the record's own words. Terminal attempts permit
// the Developer's manual fresh attempt; a parked attempt awaits the human;
// an Unknown outcome asks for reconciliation first.
export const PERMITTED_NEXT_ACTIONS = ["await-human", "manual-retry", "reconcile"];

// The budget's line kinds. They are distinct forever: a total sums its own
// kind only, an estimate never becomes reported usage, and an unknown line
// carries no number at all.
export const USAGE_LINE_KINDS = ["reported", "estimated", "unknown"];

// The typed outcomes the policy consumes — the projection of the
// pi-managed/v1 adapter's outcome surface. Anything else is rejected.
export const OUTCOME_KINDS = [
  "provider-failure",
  "policy-denied",
  "rejected",
  "cancelled",
  "unknown",
  "start-denied",
];

// The named provider failure kinds (ADR 0018's adapter vocabulary); the
// adapter maps everything else it cannot correlate onto `provider_failure`.
// Fenced against the adapter's own list in failures.test.mjs.
export const PROVIDER_FAILURE_REASONS = ["auth_required", "quota", "provider_failure"];

// The adapter's start denials (ADR 0018): every one fires before the
// runtime completed its handshake, so no prompt existed and no provider or
// tool dispatch was possible. This is the durable non-dispatch proof.
export const START_DENIAL_CODES = [
  "session_writer_exists",
  "runtime_ended",
  "handshake_violation",
  "unsupported_protocol",
  "unsupported_runtime",
];

// A runtime that fails the pinned contract (wrong first frame, unsupported
// protocol or revision) is one this adapter does not support; the writer
// claim contest and an end before the handshake are failures of the start,
// not of the contract.
const UNSUPPORTED_START_DENIALS = [
  "handshake_violation",
  "unsupported_protocol",
  "unsupported_runtime",
];

// The outcome kinds that prove no provider or tool dispatch occurred.
export const NON_DISPATCH_OUTCOME_KINDS = ["start-denied"];

// Repeated identical failure signatures halt the run at the second one: a
// manual fresh attempt that fails the same way again is a no-progress loop,
// and the run parks awaiting-human with an escalation record instead of
// inviting a third.
export const FAILURE_SIGNATURE_HALT = 2;

const policyError = (code, message) => Object.assign(new Error(message), { code });

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The classification table. `signature: true` marks the failure
// classifications whose repeats the no-progress detector counts.
const CLASSIFICATIONS = {
  "provider-failure": {
    classification: "known-failure",
    nextAction: "await-human",
    attemptState: "awaiting-human",
    signature: true,
    nonDispatchProven: false,
  },
  rejected: {
    classification: "known-failure",
    nextAction: "manual-retry",
    attemptState: "terminal",
    signature: true,
    nonDispatchProven: false,
  },
  "start-denied": {
    // Split per code below — the denial names whether the runtime could not
    // be managed (unsupported) or merely failed to start (known failure).
    nextAction: "manual-retry",
    attemptState: "terminal",
    signature: true,
    nonDispatchProven: true,
  },
  "policy-denied": {
    classification: "policy-denial",
    nextAction: "manual-retry",
    attemptState: "terminal",
    signature: true,
    nonDispatchProven: false,
  },
  cancelled: {
    classification: "cancellation",
    nextAction: "manual-retry",
    attemptState: "terminal",
    signature: false,
    nonDispatchProven: false,
  },
  unknown: {
    classification: "unknown",
    nextAction: "reconcile",
    attemptState: "unknown",
    signature: false,
    nonDispatchProven: false,
  },
};

// Classifies one typed outcome into the verdict the rest of the policy acts
// on: the Workbench-owned classification, its one permitted next action,
// the lifecycle the attempt moves to, whether the outcome proves no
// provider or tool dispatch occurred, and — for provider failures — the
// verbatim usage the provider reported. Unknown outcome kinds and unknown
// per-kind shapes are typed rejections.
export const classifyOutcome = (outcome) => {
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome))
    throw policyError("invalid_outcome", "an outcome is a typed object");
  const { kind } = outcome;
  if (!OUTCOME_KINDS.includes(kind))
    throw policyError(
      "invalid_outcome",
      `"${String(kind)}" is not an outcome kind this policy knows`,
    );

  const shape = CLASSIFICATIONS[kind];
  if (kind === "provider-failure") {
    if (!PROVIDER_FAILURE_REASONS.includes(outcome.reason))
      throw policyError(
        "invalid_outcome",
        `a provider failure names one of ${PROVIDER_FAILURE_REASONS.join(", ")}`,
      );
    if (outcome.usage !== undefined && outcome.usage !== null && !isPlainObject(outcome.usage))
      throw policyError(
        "invalid_outcome",
        "the usage a provider reported travels verbatim as an object",
      );
    return {
      kind,
      reason: outcome.reason,
      classification: shape.classification,
      nextAction: shape.nextAction,
      attemptState: shape.attemptState,
      nonDispatchProven: shape.nonDispatchProven,
      signature: shape.signature,
      usage: outcome.usage ?? null,
    };
  }
  if (kind === "start-denied") {
    if (!START_DENIAL_CODES.includes(outcome.code))
      throw policyError(
        "invalid_outcome",
        `a start denial names one of ${START_DENIAL_CODES.join(", ")}`,
      );
    return {
      kind,
      reason: outcome.code,
      classification: UNSUPPORTED_START_DENIALS.includes(outcome.code)
        ? "unsupported"
        : "known-failure",
      nextAction: shape.nextAction,
      attemptState: shape.attemptState,
      nonDispatchProven: shape.nonDispatchProven,
      signature: shape.signature,
      usage: null,
    };
  }
  return {
    kind,
    reason: null,
    classification: shape.classification,
    nextAction: shape.nextAction,
    attemptState: shape.attemptState,
    nonDispatchProven: shape.nonDispatchProven,
    signature: shape.signature,
    usage: null,
  };
};

// The failure signature: a bounded, normalized identity of one failure —
// classification, outcome kind, and the typed reason or denial code — stable
// across attempts and blind to unbounded evidence, so a no-progress loop of
// cosmetically different failures still reads as the same failure. Only
// failure classifications carry one; a cancellation is a human act and an
// Unknown outcome is uncertainty, and neither can loop.
export const failureSignature = (verdict) => {
  if (verdict === null || typeof verdict !== "object" || !verdict.signature) return undefined;
  return createHash("sha256")
    .update(`${verdict.classification}\n${verdict.kind}\n${verdict.reason ?? ""}`)
    .digest("hex")
    .slice(0, 32);
};

// Validates one usage line into the budget's normalized shape. The kinds are
// distinct forever: an unknown line carries no number, because a number
// there would be an invention; a value, when present, is a finite
// non-negative number in the line's own unit.
export const usageLine = ({ kind, unit, value, detail } = {}) => {
  if (!USAGE_LINE_KINDS.includes(kind))
    throw policyError("invalid_usage_line", `"${String(kind)}" is not a usage line kind`);
  if (typeof unit !== "string" || unit.trim() !== unit)
    throw policyError("invalid_usage_line", "a usage line names its unit");
  if (value !== undefined && value !== null) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw policyError(
        "invalid_usage_line",
        "a usage line's value is a finite non-negative number",
      );
    if (kind === "unknown")
      throw policyError(
        "invalid_usage_line",
        "an unknown line asserts availability is unknown — a value would be invented",
      );
  }
  if (detail !== undefined && detail !== null && !isPlainObject(detail))
    throw policyError("invalid_usage_line", "a usage line's detail travels verbatim as an object");
  return {
    kind,
    unit,
    value: typeof value === "number" ? value : null,
    detail: detail ?? null,
  };
};

// The budget's honest totals: sums computed within one kind and one unit,
// never across. Estimated lines can never move a reported total, and an
// unknown line contributes a count — unknown stays unknown, never a number.
export const summarizeUsageBudget = (lines) => {
  const totals = { reported: {}, estimated: {}, unknownLines: 0 };
  for (const line of lines) {
    if (line.kind === "unknown") {
      totals.unknownLines += 1;
      continue;
    }
    if (typeof line.value !== "number") continue;
    const sums = totals[line.kind];
    sums[line.unit] = (sums[line.unit] ?? 0) + line.value;
  }
  return totals;
};

// The one sentence the escalation record always carries as the next human
// decision: after a no-progress halt, what is left is the Developer's call.
const ESCALATION_DECISION = "decide whether to start a fresh manual attempt or abandon this run";

// The escalation record: a bounded operational handoff naming the repeated
// failure (its signature and repeat count), the authority that remains, and
// the next human decision. The verbatim failure evidence stays in the
// attempt's outcome event on the ledger — the record references it and
// stays bounded. Optional fields are omitted, never null, so the record and
// the ledger event built from it validate against the seam's schema.
export const escalationFor = ({ runId, attemptId, verdict, signature, repeats, at }) => ({
  runId,
  attemptId,
  signature,
  repeats,
  classification: verdict.classification,
  kind: verdict.kind,
  ...(verdict.reason !== null ? { reason: verdict.reason } : {}),
  remainingAuthority: ["manual-retry"],
  decision: ESCALATION_DECISION,
  at,
});
