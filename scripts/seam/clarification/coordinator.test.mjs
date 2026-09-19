import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClarificationCoordinator } from "./coordinator.mjs";
import { openClarificationStore } from "./store.mjs";

// Coordinator contract tests (spec #221, ticket #231, ADR 0020): the
// coordinator is the one new seam — typed events in, typed observation out.
// The store is the real SQLite implementation on a temp directory; the
// clock is injected so timestamps are deterministic.

const withCoordinator = async (fn, { eventLedgerLimit } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-clarification-coordinator-"));
  const databasePath = join(directory, "runs.sqlite");
  const store = openClarificationStore({
    hostRepo: "example/project",
    databasePath,
    clock: () => "2026-09-18T00:00:00Z",
    ...(eventLedgerLimit !== undefined ? { eventLedgerLimit } : {}),
  });
  const coordinator = createClarificationCoordinator({
    store,
    clock: () => "2026-09-18T00:00:00Z",
  });
  try {
    return await fn({ coordinator, store, databasePath });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const attemptRun = (store, requestId) => {
  const { run } = store.createRun({ issueId: "GH-42", requestId });
  const { attempt } = store.createAttempt({
    runId: run.runId,
    requestId: `${requestId}-attempt`,
    intent: { adapter: "pi-managed/v1" },
  });
  return { run, attempt };
};

const lifecycle = (state, attemptId) => ({
  type: "lifecycle",
  scope: "attempt",
  id: attemptId,
  state,
  at: "2026-09-18T00:00:01Z",
});

const conversation = (attemptId, sessionCursor = 1) => ({
  type: "conversation",
  attemptId,
  session: {
    cursor: sessionCursor,
    envelope: "pi-managed/v1",
    event: { type: "hello", protocol: "1" },
  },
});

test("observe answers the snapshot plus the events after the cursor", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-observe");
    coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });
    coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId) });

    const full = coordinator.observe({ runId: run.runId, afterCursor: 0 });
    deepStrictEqual(full.snapshot.run, store.getRun(run.runId));
    deepStrictEqual(full.snapshot.attempts, [attempt]);
    strictEqual(full.latestCursor, 2);
    strictEqual(full.events.length, 2);
    strictEqual(full.gap, undefined);

    // The same read answers a returning viewer's delta: everything after
    // its own cursor, nothing before.
    const delta = coordinator.observe({ runId: run.runId, afterCursor: 1 });
    strictEqual(delta.latestCursor, 2);
    strictEqual(delta.events.length, 1);
    strictEqual(delta.events[0].cursor, 2);

    throws(
      () => coordinator.observe({ runId: "run_missing", afterCursor: 0 }),
      (error) => error.code === "run_not_found",
    );
  });
});

test("observe carries the explicit gap when the cursor predates retention", async () => {
  await withCoordinator(
    async ({ coordinator, store }) => {
      const { run, attempt } = attemptRun(store, "r-observe-gap");
      coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });
      coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId, 1) });
      coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId, 2) });

      const expired = coordinator.observe({ runId: run.runId, afterCursor: 0 });
      deepStrictEqual(expired.gap, { after: 0, firstRetainedCursor: 2 });
      // The snapshot is complete even when the event delta is not.
      strictEqual(expired.snapshot.attempts.length, 1);
    },
    { eventLedgerLimit: 2 },
  );
});

test("a live stream replays after the cursor, follows publishes, and ends only at the terminal", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-stream");
    coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });

    const { stream } = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 0,
    });
    const frames = [];
    const read = async () => {
      const { value, done } = await stream.next();
      if (!done) frames.push(value);
      return done;
    };

    // Replay first: the event published before the attach is served from
    // the ledger, with its durable cursor.
    strictEqual(await read(), false);
    strictEqual(frames[0].cursor, 1);

    // Then the stream holds — a non-terminal publish is followed, and a
    // non-terminal classification never ends the stream.
    let pending = read();
    coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId) });
    strictEqual(await pending, false);
    strictEqual(frames[1].cursor, 2);

    // The watched attempt's terminal classification is the only end.
    pending = read();
    coordinator.publish({ runId: run.runId, event: lifecycle("terminal", attempt.attemptId) });
    strictEqual(await pending, false);
    strictEqual(frames[2].event.state, "terminal");
    strictEqual(await read(), true);
    const drained = await stream.next();
    strictEqual(drained.done, true);
  });
});

test("an attempt already terminal at attach ends the stream after its replay", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-ended");
    coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal" });
    coordinator.publish({ runId: run.runId, event: lifecycle("terminal", attempt.attemptId) });

    const { stream } = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 0,
    });
    const frames = [];
    for (let ended = false; !ended;) {
      const { value, done } = await stream.next();
      if (!done) frames.push(value);
      ended = done;
    }
    strictEqual(frames.length, 2);
    strictEqual(frames[1].event.state, "terminal");
  });
});

test("an expired cursor opens the stream with the explicit gap frame", async () => {
  await withCoordinator(
    async ({ coordinator, store }) => {
      const { run, attempt } = attemptRun(store, "r-stream-gap");
      coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });
      coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId, 1) });
      // The third event pushes the first past the retention bound, so a
      // viewer from cursor 0 is genuinely expired.
      coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId, 2) });

      const { stream } = coordinator.streamEvents({
        runId: run.runId,
        attemptId: attempt.attemptId,
        afterCursor: 0,
      });
      const first = await stream.next();
      deepStrictEqual(first.value, {
        envelope: "clarification-events/v1",
        gap: { after: 0, firstRetainedCursor: 2 },
      });
      stream.return();
    },
    { eventLedgerLimit: 2 },
  );
});

test("detaching a viewer leaves the attempt running and the record continuable", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-detach");
    coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });

    const viewer = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 0,
    });
    await viewer.stream.next();
    viewer.detach();

    // The attempt continues without its viewer: events still publish,
    // lifecycle still moves, nothing was cancelled on the disconnect.
    coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId) });
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "awaiting-human" });
    coordinator.publish({
      runId: run.runId,
      event: lifecycle("awaiting-human", attempt.attemptId),
    });

    // A returning viewer is served everything the detached viewer missed.
    const returning = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 1,
    });
    const missed = [];
    for (let i = 0; i < 2; i += 1) {
      const { value } = await returning.stream.next();
      missed.push(value);
    }
    strictEqual(missed[0].cursor, 2);
    strictEqual(missed[1].event.state, "awaiting-human");
    returning.detach();
  });
});

test("two viewers of one run keep independent cursors", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-two");
    coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });

    const first = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 0,
    });
    const second = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 1,
    });

    const pendingFirst = first.stream.next();
    const pendingSecond = second.stream.next();
    coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId) });
    const firstFrame = await pendingFirst;
    const secondFrame = await pendingSecond;
    // The first viewer replays from zero, the second from its own cursor —
    // one publish serves both, each with the delta it asked for.
    strictEqual(firstFrame.value.cursor, 1);
    strictEqual(secondFrame.value.cursor, 2);

    first.detach();
    second.detach();
  });
});

test("stream attach answers unknown runs and attempts with typed errors", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-typed");
    throws(
      () =>
        coordinator.streamEvents({
          runId: "run_missing",
          attemptId: attempt.attemptId,
          afterCursor: 0,
        }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () =>
        coordinator.streamEvents({
          runId: run.runId,
          attemptId: "attempt_missing",
          afterCursor: 0,
        }),
      (error) => error.code === "attempt_not_found",
    );
    throws(
      () =>
        coordinator.streamEvents({
          runId: run.runId,
          attemptId: attempt.attemptId,
          afterCursor: -1,
        }),
      (error) => error.code === "invalid_request",
    );
  });
});

test("publish persists to the ledger before any viewer is served", async () => {
  await withCoordinator(async ({ coordinator, store, databasePath }) => {
    const { run, attempt } = attemptRun(store, "r-publish");
    const envelope = coordinator.publish({
      runId: run.runId,
      event: lifecycle("active", attempt.attemptId),
    });
    ok(envelope.cursor >= 1);
    strictEqual(envelope.envelope, "clarification-events/v1");
    deepStrictEqual(envelope.event, lifecycle("active", attempt.attemptId));

    // Publication draws from the durable ledger: an independent store
    // handle on the same file — no shared memory with the coordinator —
    // already serves the event. Nothing was published that is not durable.
    const independent = openClarificationStore({
      hostRepo: "example/project",
      databasePath,
      clock: () => "2026-09-18T00:00:00Z",
    });
    const read = independent.readEvents({ runId: run.runId, afterCursor: 0 });
    deepStrictEqual(read.events, [envelope]);
    independent.close();

    // Publishing against a run this host repo cannot see is typed.
    throws(
      () =>
        coordinator.publish({
          runId: "run_missing",
          event: lifecycle("active", attempt.attemptId),
        }),
      (error) => error.code === "run_not_found",
    );
  });
});

// --- Ticket #235: the failure policy (ADR 0023). Outcomes classify into
// Workbench-owned classifications with one bounded permitted next action;
// quota and auth park awaiting-human with the budget preserved; exactly one
// coordinator retry exists behind durable non-dispatch evidence; repeated
// identical failure signatures halt with an escalation record; the usage
// budget spans attempts and restarts. ---

test("a quota failure parks awaiting-human, folds its usage, and preserves the budget", async () => {
  await withCoordinator(async ({ coordinator, store, databasePath }) => {
    const { run, attempt } = attemptRun(store, "r-quota");
    coordinator.recordUsage({
      runId: run.runId,
      line: { kind: "estimated", unit: "tokens", value: 500 },
    });

    const verdict = coordinator.recordOutcome({
      runId: run.runId,
      attemptId: attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota", usage: { total: 12 } },
    });
    strictEqual(verdict.classification, "known-failure");
    strictEqual(verdict.nextAction, "await-human");
    strictEqual(verdict.attemptState, "awaiting-human");

    // The attempt is parked — never retried, fallen back, or terminated.
    strictEqual(store.getAttempt(attempt.attemptId).state, "awaiting-human");
    // Nothing automatic happened beyond the park: the run stays active and
    // no second attempt appeared on its own.
    strictEqual(store.getRun(run.runId).state, "active");
    strictEqual(store.listAttempts(run.runId).length, 1);

    // The outcome and the lifecycle move it drives landed together.
    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      events.map((envelope) => envelope.event.type),
      ["outcome", "lifecycle"],
    );
    deepStrictEqual(events[0].event, {
      type: "outcome",
      scope: "attempt",
      id: attempt.attemptId,
      kind: "provider-failure",
      classification: "known-failure",
      nextAction: "await-human",
      reason: "quota",
      signature: verdict.signature,
      usage: { total: 12 },
      at: "2026-09-18T00:00:00Z",
    });
    strictEqual(events[1].event.state, "awaiting-human");

    // The budget now carries the estimate from before the park and the
    // provider-reported usage verbatim — distinct kinds, no conversion.
    const budget = coordinator.usageBudget({ runId: run.runId });
    deepStrictEqual(
      budget.lines.map((line) => [line.kind, line.unit, line.value, line.detail ?? null]),
      [
        ["estimated", "tokens", 500, null],
        ["reported", "provider", null, { total: 12 }],
      ],
    );
    deepStrictEqual(budget.totals, { reported: {}, estimated: { tokens: 500 }, unknownLines: 0 });

    // The parked attempt's verdict is on the durable row.
    deepStrictEqual(store.getAttempt(attempt.attemptId).outcome, {
      kind: "provider-failure",
      classification: "known-failure",
      nextAction: "await-human",
      reason: "quota",
      signature: verdict.signature,
      at: "2026-09-18T00:00:00Z",
    });

    // The budget spans restarts: an independent handle on the same file
    // reads it back.
    const reopened = openClarificationStore({
      hostRepo: "example/project",
      databasePath,
      clock: () => "2026-09-18T00:00:00Z",
    });
    deepStrictEqual(reopened.usageBudgetFor(run.runId).lines.length, 2);
    strictEqual(reopened.getAttempt(attempt.attemptId).state, "awaiting-human");
    reopened.close();
  });
});

test("every classification lands with its bounded next action", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const cases = [
      {
        outcome: { kind: "rejected", evidence: { error: "bad prompt" } },
        classification: "known-failure",
        nextAction: "manual-retry",
        attemptState: "terminal",
        signature: true,
      },
      {
        outcome: { kind: "policy-denied", evidence: { denied: "network" } },
        classification: "policy-denial",
        nextAction: "manual-retry",
        attemptState: "terminal",
        signature: true,
      },
      {
        outcome: { kind: "cancelled" },
        classification: "cancellation",
        nextAction: "manual-retry",
        attemptState: "terminal",
        signature: false,
      },
      {
        outcome: { kind: "unknown", endReason: "eof", exit: 1 },
        classification: "unknown",
        nextAction: "reconcile",
        attemptState: "unknown",
        signature: false,
      },
      {
        outcome: { kind: "start-denied", code: "unsupported_protocol" },
        classification: "unsupported",
        nextAction: "manual-retry",
        attemptState: "terminal",
        signature: true,
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const { run, attempt } = attemptRun(store, `r-classify-${index}`);
      const verdict = coordinator.recordOutcome({
        runId: run.runId,
        attemptId: attempt.attemptId,
        outcome: testCase.outcome,
      });
      strictEqual(verdict.classification, testCase.classification, testCase.outcome.kind);
      strictEqual(verdict.nextAction, testCase.nextAction, testCase.outcome.kind);
      strictEqual(
        store.getAttempt(attempt.attemptId).state,
        testCase.attemptState,
        testCase.outcome.kind,
      );
      const [outcomeEnvelope] = store
        .readEvents({ runId: run.runId, afterCursor: 0 })
        .events.map((envelope) => envelope.event)
        .filter((event) => event.type === "outcome");
      strictEqual(outcomeEnvelope.nextAction, testCase.nextAction, testCase.outcome.kind);
      if (testCase.signature)
        ok(typeof outcomeEnvelope.signature === "string", testCase.outcome.kind);
      else strictEqual(outcomeEnvelope.signature, undefined, testCase.outcome.kind);
    }
  });
});

test("an outcome that does not classify is a typed rejection that writes nothing", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-invalid");
    throws(
      () =>
        coordinator.recordOutcome({
          runId: run.runId,
          attemptId: attempt.attemptId,
          outcome: { kind: "vibes" },
        }),
      (error) => error.code === "invalid_outcome",
    );
    throws(
      () =>
        coordinator.recordOutcome({
          runId: run.runId,
          attemptId: attempt.attemptId,
          outcome: { kind: "provider-failure", reason: "reanimated" },
        }),
      (error) => error.code === "invalid_outcome",
    );
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 0);
    strictEqual(store.getAttempt(attempt.attemptId).state, "active");

    // A terminal attempt records nothing further.
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal" });
    throws(
      () =>
        coordinator.recordOutcome({
          runId: run.runId,
          attemptId: attempt.attemptId,
          outcome: { kind: "cancelled" },
        }),
      (error) => error.code === "illegal_transition",
    );
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 0);
  });
});

test("marking dispatch publishes evidence the retry gate can lean on", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-mark");
    const marked = coordinator.markDispatched({
      runId: run.runId,
      attemptId: attempt.attemptId,
      evidence: { argv: ["pi", "--mode", "rpc", "--no-retry"] },
    });
    strictEqual(marked.dispatchedAt, "2026-09-18T00:00:00Z");
    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      events.map((envelope) => envelope.event.type),
      ["dispatch"],
    );
    strictEqual(events[0].event.id, attempt.attemptId);

    // A second mark is a typed refusal — the first is the record.
    throws(
      () => coordinator.markDispatched({ runId: run.runId, attemptId: attempt.attemptId }),
      (error) => error.code === "dispatch_marked",
    );
  });
});

test("repeated identical failure signatures halt the run with an escalation record", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-loop" });
    const first = store.createAttempt({ runId: run.runId, requestId: "a-1", intent: {} });
    const second = store.createAttempt({ runId: run.runId, requestId: "a-2", intent: {} });
    const third = store.createAttempt({ runId: run.runId, requestId: "a-3", intent: {} });

    // First identical failure: recorded, not yet a loop.
    const firstVerdict = coordinator.recordOutcome({
      runId: run.runId,
      attemptId: first.attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota" },
    });
    strictEqual(store.getRun(run.runId).state, "active");
    deepStrictEqual(store.listEscalations(run.runId), []);

    // The manual fresh attempt fails the same way: that is a no-progress
    // loop — the run halts awaiting-human with the escalation record.
    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: second.attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota" },
    });
    strictEqual(store.getRun(run.runId).state, "awaiting-human");
    const escalations = store.listEscalations(run.runId);
    strictEqual(escalations.length, 1);
    strictEqual(escalations[0].signature, firstVerdict.signature);
    strictEqual(escalations[0].repeats, 2);
    deepStrictEqual(escalations[0].remainingAuthority, ["manual-retry"]);
    ok(escalations[0].decision.length > 0);
    const ledgerTypes = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.map((envelope) => envelope.event)
      .filter((event) => event.type === "escalation");
    strictEqual(ledgerTypes.length, 1);

    // A third attempt already in flight failing identically escalates
    // nothing new — the halt is idempotent per signature.
    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: third.attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota" },
    });
    strictEqual(store.listEscalations(run.runId).length, 1);
    strictEqual(store.getRun(run.runId).state, "awaiting-human");
  });
});

test("different failure signatures count separately; the human decision reopens a halt", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-two-sigs" });
    const first = store.createAttempt({ runId: run.runId, requestId: "a-1", intent: {} });
    const second = store.createAttempt({ runId: run.runId, requestId: "a-2", intent: {} });
    const third = store.createAttempt({ runId: run.runId, requestId: "a-3", intent: {} });

    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: first.attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota" },
    });
    // A different reason is a different signature: one repeat does not halt.
    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: second.attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "auth_required" },
    });
    strictEqual(store.getRun(run.runId).state, "active");
    strictEqual(store.listEscalations(run.runId).length, 0);

    // The quota failure repeats: its own loop halts the run.
    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: third.attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota" },
    });
    strictEqual(store.getRun(run.runId).state, "awaiting-human");
    const escalated = store.listEscalations(run.runId);
    strictEqual(escalated.length, 1);
    strictEqual(escalated[0].reason, "quota");

    // The explicit human decision moves the run back and new attempts may
    // start — the Developer's manual fresh attempt, never an automatic one.
    store.updateRunState({ runId: run.runId, to: "active" });
    const { attempt } = store.createAttempt({ runId: run.runId, requestId: "a-4", intent: {} });
    strictEqual(attempt.origin, "manual");
  });
});

test("the coordinator retry fires once, only on proven non-dispatch", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-retry");
    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: attempt.attemptId,
      outcome: { kind: "start-denied", code: "runtime_ended" },
    });

    const retry = coordinator.requestCoordinatorRetry({
      runId: run.runId,
      fromAttemptId: attempt.attemptId,
      requestId: "retry-1",
      intent: { adapter: "pi-managed/v1", contextDigest: "sha-256:def456" },
    });
    strictEqual(retry.created, true);
    strictEqual(retry.attempt.origin, "coordinator-retry");
    deepStrictEqual(retry.attempt.dispatchIntent, {
      adapter: "pi-managed/v1",
      contextDigest: "sha-256:def456",
    });

    // The retry decision is evidence on the ledger.
    const retries = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.map((envelope) => envelope.event)
      .filter((event) => event.type === "retry");
    strictEqual(retries.length, 1);
    deepStrictEqual(retries[0], {
      type: "retry",
      scope: "run",
      id: run.runId,
      fromAttemptId: attempt.attemptId,
      attemptId: retry.attempt.attemptId,
      basis: "proven-non-dispatch",
      at: "2026-09-18T00:00:00Z",
    });

    // Exactly once: a second coordinator retry is a typed refusal.
    throws(
      () =>
        coordinator.requestCoordinatorRetry({
          runId: run.runId,
          fromAttemptId: attempt.attemptId,
          requestId: "retry-2",
          intent: {},
        }),
      (error) => error.code === "coordinator_retry_spent",
    );

    // A replayed retry request (the same request id) deduplicates to the
    // same attempt — it never creates a second one.
    const replay = coordinator.requestCoordinatorRetry({
      runId: run.runId,
      fromAttemptId: attempt.attemptId,
      requestId: "retry-1",
      intent: {},
    });
    strictEqual(replay.created, false);
    strictEqual(replay.attempt.attemptId, retry.attempt.attemptId);
  });
});

test("the coordinator retry refuses every outcome that does not prove non-dispatch", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const refusals = [
      { outcome: { kind: "provider-failure", reason: "quota" } },
      { outcome: { kind: "rejected", evidence: {} } },
      { outcome: { kind: "policy-denied", evidence: {} } },
      { outcome: { kind: "cancelled" } },
      { outcome: { kind: "unknown", endReason: "eof" } },
    ];
    for (const [index, refusal] of refusals.entries()) {
      const { run, attempt } = attemptRun(store, `r-refuse-${index}`);
      coordinator.recordOutcome({
        runId: run.runId,
        attemptId: attempt.attemptId,
        outcome: refusal.outcome,
      });
      throws(
        () =>
          coordinator.requestCoordinatorRetry({
            runId: run.runId,
            fromAttemptId: attempt.attemptId,
            requestId: `retry-${index}`,
            intent: {},
          }),
        (error) => error.code === "retry_not_eligible",
        refusal.outcome.kind,
      );
    }

    // The lying-reporter fence: an attempt marked dispatched can never
    // ground a non-dispatch retry, whatever the outcome claims.
    const { run, attempt } = attemptRun(store, "r-marked");
    coordinator.markDispatched({ runId: run.runId, attemptId: attempt.attemptId });
    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: attempt.attemptId,
      outcome: { kind: "start-denied", code: "runtime_ended" },
    });
    throws(
      () =>
        coordinator.requestCoordinatorRetry({
          runId: run.runId,
          fromAttemptId: attempt.attemptId,
          requestId: "retry-marked",
          intent: {},
        }),
      (error) => error.code === "retry_not_eligible",
    );

    // The typed lookups fail before the gate is even consulted.
    const { run: visible } = store.createRun({ issueId: "GH-42", requestId: "r-refs" });
    throws(
      () =>
        coordinator.requestCoordinatorRetry({
          runId: "run_missing",
          fromAttemptId: attempt.attemptId,
          requestId: "x",
          intent: {},
        }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () =>
        coordinator.requestCoordinatorRetry({
          runId: visible.runId,
          fromAttemptId: attempt.attemptId,
          requestId: "x",
          intent: {},
        }),
      (error) => error.code === "attempt_not_found",
    );

    // A halted run dispatches nothing, coordinator retry included.
    const { run: halted } = store.createRun({ issueId: "GH-42", requestId: "r-halted-run" });
    store.updateRunState({ runId: halted.runId, to: "awaiting-human" });
    throws(
      () =>
        coordinator.requestCoordinatorRetry({
          runId: halted.runId,
          fromAttemptId: attempt.attemptId,
          requestId: "x",
          intent: {},
        }),
      (error) => error.code === "run_not_active",
    );
  });
});

test("usage lines through the coordinator keep their kinds distinct forever", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-budget" });
    coordinator.recordUsage({
      runId: run.runId,
      line: { kind: "reported", unit: "usd", value: 0.25 },
    });
    coordinator.recordUsage({
      runId: run.runId,
      line: { kind: "estimated", unit: "usd", value: 10 },
    });
    coordinator.recordUsage({ runId: run.runId, line: { kind: "unknown", unit: "usd" } });

    const budget = coordinator.usageBudget({ runId: run.runId });
    // The estimate never becomes reported usage; unknown stays unknown.
    deepStrictEqual(budget.totals, {
      reported: { usd: 0.25 },
      estimated: { usd: 10 },
      unknownLines: 1,
    });

    throws(
      () =>
        coordinator.recordUsage({
          runId: run.runId,
          line: { kind: "guessed", unit: "usd", value: 1 },
        }),
      (error) => error.code === "invalid_usage_line",
    );
    throws(
      () =>
        coordinator.recordUsage({
          runId: run.runId,
          line: { kind: "unknown", unit: "usd", value: 5 },
        }),
      (error) => error.code === "invalid_usage_line",
    );
    strictEqual(coordinator.usageBudget({ runId: run.runId }).lines.length, 3);
  });
});

test("a live viewer sees outcome and escalation events as they land", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-viewer");
    const { stream } = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 0,
    });

    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota", usage: { total: 7 } },
    });
    const frames = [];
    for (let i = 0; i < 2; i += 1) {
      const { value } = await stream.next();
      frames.push(value);
    }
    deepStrictEqual(
      frames.map((frame) => frame.event.type),
      ["outcome", "lifecycle"],
    );
    strictEqual(frames[1].event.state, "awaiting-human");
    stream.return();
  });
});
