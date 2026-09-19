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
  const coordinator = createClarificationCoordinator({ store });
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
