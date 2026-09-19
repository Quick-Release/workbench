import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import test from "node:test";

import {
  FAILURE_CLASSIFICATIONS,
  FAILURE_SIGNATURE_HALT,
  NON_DISPATCH_OUTCOME_KINDS,
  OUTCOME_KINDS,
  PERMITTED_NEXT_ACTIONS,
  PROVIDER_FAILURE_REASONS,
  START_DENIAL_CODES,
  USAGE_LINE_KINDS,
  classifyOutcome,
  escalationFor,
  failureSignature,
  summarizeUsageBudget,
  usageLine,
} from "./failures.mjs";
import {
  clarificationFailureClassifications,
  clarificationLifecycleStates,
  clarificationNextActions,
  clarificationUsageLineKinds,
} from "../../../src/types.ts";

// The failure policy's vocabulary and rules (spec #221, ticket #235, ADR
// 0023): Workbench-owned classifications keep known failure, unsupported,
// policy denial, cancellation and Unknown outcome distinct, each mapped to
// one bounded permitted next action. Everything here is pure and total over
// its closed vocabularies — an outcome outside them is a typed rejection,
// never a guess.

test("the policy's vocabularies never drift from the seam's mirrored words", () => {
  deepStrictEqual([...FAILURE_CLASSIFICATIONS], [...clarificationFailureClassifications]);
  deepStrictEqual([...PERMITTED_NEXT_ACTIONS], [...clarificationNextActions]);
  deepStrictEqual([...USAGE_LINE_KINDS], [...clarificationUsageLineKinds]);
});

test("every outcome kind classifies into the closed vocabularies", () => {
  const outcomes = {
    "provider-failure": { kind: "provider-failure", reason: "quota" },
    "policy-denied": { kind: "policy-denied", evidence: { denied: true } },
    rejected: { kind: "rejected", evidence: { error: "bad prompt" } },
    cancelled: { kind: "cancelled" },
    unknown: { kind: "unknown", endReason: "eof", exit: 1 },
    "start-denied": { kind: "start-denied", code: "handshake_violation" },
  };
  deepStrictEqual(Object.keys(outcomes).sort(), [...OUTCOME_KINDS].sort());
  for (const outcome of Object.values(outcomes)) {
    const verdict = classifyOutcome(outcome);
    ok(FAILURE_CLASSIFICATIONS.includes(verdict.classification), verdict.classification);
    ok(PERMITTED_NEXT_ACTIONS.includes(verdict.nextAction), verdict.nextAction);
    ok(clarificationLifecycleStates.includes(verdict.attemptState), verdict.attemptState);
    strictEqual(verdict.kind, outcome.kind);
  }
});

test("quota and auth failures are known failures that park awaiting-human", () => {
  for (const reason of PROVIDER_FAILURE_REASONS) {
    const verdict = classifyOutcome({ kind: "provider-failure", reason, usage: { total: 12 } });
    strictEqual(verdict.classification, "known-failure", reason);
    strictEqual(verdict.nextAction, "await-human", reason);
    strictEqual(verdict.attemptState, "awaiting-human", reason);
    // The provider was reached — dispatch happened, so the coordinator's one
    // evidence-gated retry must never see this as proven non-dispatch.
    strictEqual(verdict.nonDispatchProven, false, reason);
    deepStrictEqual(verdict.usage, { total: 12 }, reason);
  }
});

test("a provider failure without a known reason is a typed rejection", () => {
  throws(
    () => classifyOutcome({ kind: "provider-failure", reason: "overflow" }),
    (error) => error.code === "invalid_outcome",
  );
  throws(
    () => classifyOutcome({ kind: "provider-failure" }),
    (error) => error.code === "invalid_outcome",
  );
});

test("every start denial proves non-dispatch; the pinned-contract ones are unsupported", () => {
  const unsupported = ["handshake_violation", "unsupported_protocol", "unsupported_runtime"];
  const known = ["session_writer_exists", "runtime_ended"];
  deepStrictEqual([...START_DENIAL_CODES].sort(), [...unsupported, ...known].sort());
  for (const code of START_DENIAL_CODES) {
    const verdict = classifyOutcome({ kind: "start-denied", code });
    strictEqual(verdict.nonDispatchProven, true, code);
    strictEqual(verdict.nextAction, "manual-retry", code);
    strictEqual(verdict.attemptState, "terminal", code);
    if (unsupported.includes(code)) strictEqual(verdict.classification, "unsupported", code);
    else strictEqual(verdict.classification, "known-failure", code);
  }
  throws(
    () => classifyOutcome({ kind: "start-denied", code: "spawn_segfault" }),
    (error) => error.code === "invalid_outcome",
  );
});

test("only the start denials count as proven non-dispatch", () => {
  deepStrictEqual([...NON_DISPATCH_OUTCOME_KINDS], ["start-denied"]);
  for (const kind of OUTCOME_KINDS) {
    const outcome = {
      "provider-failure": { kind, reason: "quota" },
      "start-denied": { kind, code: "runtime_ended" },
      unknown: { kind, endReason: "eof" },
    }[kind] ?? { kind };
    strictEqual(classifyOutcome(outcome).nonDispatchProven, kind === "start-denied", kind);
  }
});

test("failure outcomes carry a bounded signature; cancellation and unknown carry none", () => {
  strictEqual(failureSignature(classifyOutcome({ kind: "cancelled" })), undefined);
  strictEqual(failureSignature(classifyOutcome({ kind: "unknown", endReason: "eof" })), undefined);

  const signature = failureSignature(
    classifyOutcome({ kind: "provider-failure", reason: "quota" }),
  );
  ok(/^[0-9a-f]{1,32}$/.test(signature), signature);
  // The signature is the failure's normalized identity — classification,
  // kind, reason — stable across attempts and blind to unbounded evidence.
  deepStrictEqual(
    signature,
    failureSignature(
      classifyOutcome({ kind: "provider-failure", reason: "quota", evidence: { other: true } }),
    ),
  );
  ok(
    signature !==
      failureSignature(classifyOutcome({ kind: "provider-failure", reason: "auth_required" })),
  );
  ok(signature !== failureSignature(classifyOutcome({ kind: "rejected" })));
});

test("usage lines keep reported, estimated and unknown distinct", () => {
  deepStrictEqual(usageLine({ kind: "reported", unit: "tokens", value: 120 }), {
    kind: "reported",
    unit: "tokens",
    value: 120,
    detail: null,
  });
  deepStrictEqual(usageLine({ kind: "estimated", unit: "usd", value: 0.5 }), {
    kind: "estimated",
    unit: "usd",
    value: 0.5,
    detail: null,
  });
  // An unknown line asserts that availability is unknown — a number there
  // would be an invention.
  deepStrictEqual(usageLine({ kind: "unknown", unit: "tokens" }), {
    kind: "unknown",
    unit: "tokens",
    value: null,
    detail: null,
  });
  throws(
    () => usageLine({ kind: "unknown", unit: "tokens", value: 10 }),
    (error) => error.code === "invalid_usage_line",
  );
  throws(
    () => usageLine({ kind: "guessed", unit: "tokens", value: 1 }),
    (error) => error.code === "invalid_usage_line",
  );
  throws(
    () => usageLine({ kind: "reported", unit: "tokens", value: -1 }),
    (error) => error.code === "invalid_usage_line",
  );
  throws(
    () => usageLine({ kind: "reported", unit: "  ", value: 1 }),
    (error) => error.code === "invalid_usage_line",
  );
});

test("budget totals sum within a kind and unit, and never across them", () => {
  const totals = summarizeUsageBudget([
    usageLine({ kind: "reported", unit: "tokens", value: 120 }),
    usageLine({ kind: "reported", unit: "tokens", value: 30 }),
    usageLine({ kind: "reported", unit: "usd", value: 0.75 }),
    // A reported line with no number stays out of the totals — there is
    // nothing honest to add.
    usageLine({ kind: "reported", unit: "provider" }),
    usageLine({ kind: "estimated", unit: "tokens", value: 500 }),
    usageLine({ kind: "unknown", unit: "tokens" }),
  ]);
  deepStrictEqual(totals.reported, { tokens: 150, usd: 0.75 });
  deepStrictEqual(totals.estimated, { tokens: 500 });
  strictEqual(totals.unknownLines, 1);

  deepStrictEqual(summarizeUsageBudget([]), { reported: {}, estimated: {}, unknownLines: 0 });
});

test("an escalation record is a bounded handoff naming the next human decision", () => {
  const verdict = classifyOutcome({ kind: "provider-failure", reason: "quota" });
  const escalation = escalationFor({
    runId: "run_1",
    attemptId: "attempt_1",
    verdict,
    signature: failureSignature(verdict),
    repeats: 2,
    at: "2026-09-19T00:00:00Z",
  });
  deepStrictEqual(escalation, {
    runId: "run_1",
    attemptId: "attempt_1",
    signature: failureSignature(verdict),
    repeats: 2,
    classification: "known-failure",
    kind: "provider-failure",
    reason: "quota",
    remainingAuthority: ["manual-retry"],
    decision: escalationFor.DECISION,
    at: "2026-09-19T00:00:00Z",
  });
  strictEqual(FAILURE_SIGNATURE_HALT, 2);
});
