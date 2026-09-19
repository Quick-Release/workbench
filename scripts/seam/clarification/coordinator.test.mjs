import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClarificationCoordinator } from "./coordinator.mjs";
import { openClarificationStore } from "./store.mjs";

// The clarification coordinator's contract tests (spec #221, tickets #230 +
// #231, ADR 0020): typed commands in, typed results and rejections out, and
// typed observation over the durable ledger. Two tiers share this suite:
// fake-port tests order the coordinator's mutations and rejections, and
// store-backed tests run the observation half against real SQLite on a temp
// directory. No real tracker, no real runtime; clocks are injected.

// A fake tracker read shaped like collectTrackerContext's result.
const collectedIssue = (overrides = {}) => ({
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

// A fake durable store: the port surface the coordinator uses, recording
// every call in order so tests assert what was durable before what. The
// records it returns are stateful — a created run is visible to the next
// listRuns — and `log` shares one ordered log across the store and session
// fakes.
const fakeStore = (overrides = {}, log = []) => {
  const calls = log;
  const runs = overrides.runs ?? [];
  const attempts = overrides.attempts ?? [];
  const now = "2026-09-18T10:00:01.000Z";
  const store = {
    calls,
    createRun: ({ issueId, requestId }) => {
      calls.push(["createRun", { issueId, requestId }]);
      const replayed = runs.find((r) => r.requestId === requestId);
      if (replayed) return { run: replayed, created: false };
      const run = {
        runId: `run_${runs.length + 1}`,
        hostRepo: "Quick-Release/workbench",
        issueId,
        requestId,
        state: "active",
        createdAt: now,
        updatedAt: now,
      };
      runs.push(run);
      return { run, created: true };
    },
    acquireLease: ({ runId, owner }) => {
      calls.push(["acquireLease", { runId, owner }]);
      return {
        lease: {
          token: "lease_1",
          generation: 1,
          owner,
          acquiredAt: "2026-09-18T10:00:02.000Z",
          expiresAt: "2026-09-18T10:00:32.000Z",
        },
      };
    },
    appendEvent: ({ runId, kind, data, leaseToken }) => {
      calls.push(["appendEvent", { runId, kind, data, leaseToken }]);
      return { seq: calls.filter(([k]) => k === "appendEvent").length, kind, data };
    },
    appendEvents: ({ runId, events }) => {
      calls.push(["appendEvents", { runId, events }]);
      return events.map((event, index) => ({
        cursor: index + 1,
        envelope: "clarification-events/v1",
        event,
      }));
    },
    readEvents: (args) => {
      calls.push(["readEvents", args]);
      return { events: [], latestCursor: 0 };
    },
    createAttempt: ({ runId, requestId, intent, leaseToken }) => {
      calls.push(["createAttempt", { runId, requestId, intent, leaseToken }]);
      const replayed = attempts.find((a) => a.runId === runId && a.requestId === requestId);
      if (replayed) return { attempt: replayed, created: false };
      const attempt = {
        attemptId: `attempt_${attempts.length + 1}`,
        runId,
        hostRepo: "Quick-Release/workbench",
        requestId,
        dispatchIntent: intent,
        state: "active",
        createdAt: "2026-09-18T10:00:03.000Z",
        updatedAt: "2026-09-18T10:00:03.000Z",
        result: null,
      };
      attempts.push(attempt);
      return { attempt, created: true };
    },
    recordAttemptResult: (args) => {
      calls.push(["recordAttemptResult", args]);
      return null;
    },
    updateAttemptState: (args) => {
      calls.push(["updateAttemptState", args]);
      return null;
    },
    updateRunState: (args) => {
      calls.push(["updateRunState", args]);
      return null;
    },
    getRun: (runId) => {
      calls.push(["getRun", { runId }]);
      return runs.find((r) => r.runId === runId) ?? null;
    },
    listRuns: () => {
      calls.push(["listRuns", {}]);
      return [...runs];
    },
    listAttempts: (runId) => {
      calls.push(["listAttempts", { runId }]);
      return attempts.filter((a) => a.runId === runId);
    },
    getSnapshot: (runId) => {
      calls.push(["getSnapshot", { runId }]);
      return null;
    },
    ...overrides,
  };
  return store;
};

const fakeTracker = (result) => ({
  readContext: async ({ issueNumber }) => {
    if (typeof result === "function") return result({ issueNumber });
    return result;
  },
});

const fakeSessions = (overrides = {}, log = []) => {
  const start = async (args) => {
    log.push(["sessions.start", args]);
    start.calls.push(args);
    return { sessionId: `pi-session-${args.attemptId}` };
  };
  start.calls = [];
  return { start, ...overrides };
};

const clock = () => "2026-09-18T10:00:00.000Z";

const coordinator = (overrides = {}) =>
  createClarificationCoordinator({
    store: overrides.store ?? fakeStore(),
    tracker: overrides.tracker ?? fakeTracker(collectedIssue()),
    sessions: overrides.sessions ?? fakeSessions(),
    clock,
    provider: "openai-codex-oauth",
    dataDestination: "https://api.openai.com",
    ...overrides,
  });

test("the manifest renders the fixed display contract over the collected read", async () => {
  const manifest = await coordinator().manifest({ issueNumber: 230 });

  deepStrictEqual(manifest.issue.number, 230);
  deepStrictEqual(manifest.issue.title, "Clarification 09");
  deepStrictEqual(manifest.issue.revision, {
    updatedAt: "2026-09-18T10:00:00.000Z",
    bodyHash: "sha-256:abc",
  });
  deepStrictEqual(manifest.provider, "openai-codex-oauth");
  deepStrictEqual(manifest.dataDestination, "https://api.openai.com");
  deepStrictEqual(manifest.capabilitySummary.length, 3);
  match(
    manifest.egressStatement,
    /private repository and issue content never enters public queries/,
  );
  match(manifest.budgetLine, /provider-reported/);
  // The display contract's one fixed ending: the manifest always closes
  // with the no-publishing line, never a variant of it.
  deepStrictEqual(manifest.noPublishingLine, "Publishing is NOT granted by this approval");
});

test("an incomplete tracker read refuses the manifest with a typed rejection", async () => {
  const failing = coordinator({
    tracker: fakeTracker(collectedIssue({ failed: true, revision: null, issue: null })),
  });
  await rejects(
    () => failing.manifest({ issueNumber: 230 }),
    (error) => error.code === "context_unavailable",
  );
});

test("start makes the run and attempt durable before the managed session dispatch", async () => {
  const log = [];
  const store = fakeStore({}, log);
  const sessions = fakeSessions({}, log);
  const result = await coordinator({ store, sessions }).start({
    issueNumber: 230,
    requestId: "req-1",
    revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
  });

  strictEqual(result.started, true);
  deepStrictEqual(result.run.runId, "run_1");
  deepStrictEqual(result.attempt.attemptId, "attempt_1");
  deepStrictEqual(sessions.start.calls.length, 1);

  // Durability ordering: the run record, the lease, and the attempt (with
  // its dispatch intent) are all committed before the one side effect —
  // the managed session start — happens last. The attempt going active is
  // published only after that, from the durable record.
  const kinds = log.map(([kind]) => kind);
  deepStrictEqual(kinds, [
    "listRuns",
    "createRun",
    "acquireLease",
    "appendEvent",
    "createAttempt",
    "appendEvent",
    "sessions.start",
    "appendEvents",
  ]);
  strictEqual(store.calls[4][1].intent.issueNumber, 230);
  deepStrictEqual(store.calls[4][1].intent.revision, {
    updatedAt: "2026-09-18T10:00:00.000Z",
    bodyHash: "sha-256:abc",
  });
  // Every fenced mutation presents the acquired lease token — a stale
  // generation cannot write through the coordinator.
  strictEqual(store.calls[4][1].leaseToken, "lease_1");
  strictEqual(store.calls[3][1].leaseToken, "lease_1");
  // The publication is the attempt's active lifecycle evidence.
  const published = log.find(([kind]) => kind === "appendEvents")[1];
  deepStrictEqual(published.events, [
    {
      type: "lifecycle",
      scope: "attempt",
      id: "attempt_1",
      state: "active",
      at: clock(),
    },
  ]);
});

test("a replayed request id answers the existing record and never dispatches again", async () => {
  const existingRun = {
    runId: "run_9",
    hostRepo: "Quick-Release/workbench",
    issueId: "230",
    requestId: "req-1",
    state: "active",
    createdAt: "2026-09-18T09:00:00.000Z",
    updatedAt: "2026-09-18T09:00:00.000Z",
  };
  const existingAttempt = {
    attemptId: "attempt_9",
    runId: "run_9",
    hostRepo: "Quick-Release/workbench",
    requestId: "req-1",
    dispatchIntent: { issueNumber: 230 },
    state: "active",
    createdAt: "2026-09-18T09:00:01.000Z",
    updatedAt: "2026-09-18T09:00:01.000Z",
    result: null,
  };
  const store = fakeStore({
    listRuns: () => [existingRun],
    listAttempts: (runId) => (runId === "run_9" ? [existingAttempt] : []),
  });
  const sessions = fakeSessions();
  const result = await coordinator({ store, sessions }).start({
    issueNumber: 230,
    requestId: "req-1",
    revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
  });

  strictEqual(result.started, false);
  deepStrictEqual(result.run.runId, "run_9");
  deepStrictEqual(result.attempt.attemptId, "attempt_9");
  // The replay is a read of the durable record: no dispatch, no mutation.
  deepStrictEqual(sessions.start.calls, []);
  strictEqual(
    store.calls.filter(([kind]) =>
      ["createRun", "acquireLease", "createAttempt", "appendEvent", "appendEvents"].includes(kind),
    ).length,
    0,
  );
});

const matchingRevision = { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" };

test("a start whose presented revision no longer matches the fresh read is a typed stale rejection", async () => {
  const store = fakeStore();
  await rejects(
    () =>
      coordinator({ store }).start({
        issueNumber: 230,
        requestId: "req-1",
        revision: { updatedAt: "2026-09-17T00:00:00.000Z", bodyHash: "sha-256:old" },
      }),
    (error) => error.code === "manifest_stale",
  );
  // The refusal precedes anything durable: no run, no lease, no attempt.
  strictEqual(store.calls.filter(([kind]) => kind !== "listRuns").length, 0);
});

test("a start for an issue with a run in flight is a typed busy rejection", async () => {
  const inFlight = {
    runId: "run_1",
    hostRepo: "Quick-Release/workbench",
    issueId: "230",
    requestId: "req-earlier",
    state: "active",
    createdAt: "2026-09-18T09:00:00.000Z",
    updatedAt: "2026-09-18T09:00:00.000Z",
  };
  const store = fakeStore({ listRuns: () => [inFlight] });
  await rejects(
    () =>
      coordinator({ store }).start({
        issueNumber: 230,
        requestId: "req-2",
        revision: matchingRevision,
      }),
    (error) => error.code === "busy",
  );
  strictEqual(store.calls.filter(([kind]) => kind !== "listRuns").length, 0);
});

test("a start refused by the lease is a typed busy rejection, not a queue", async () => {
  const store = fakeStore({
    acquireLease: () => {
      throw Object.assign(new Error("the controller lease is held by someone else"), {
        code: "lease_held",
      });
    },
  });
  await rejects(
    () =>
      coordinator({ store }).start({
        issueNumber: 230,
        requestId: "req-1",
        revision: matchingRevision,
      }),
    (error) => error.code === "busy",
  );
});

test("a start racing an in-flight start for the same issue is a typed busy rejection", async () => {
  let releaseRead;
  const gate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const tracker = {
    readContext: async () => {
      await gate;
      return collectedIssue();
    },
  };
  const log = [];
  const store = fakeStore({}, log);
  const sessions = fakeSessions({}, log);
  const c = coordinator({ store, tracker, sessions });
  const first = c.start({ issueNumber: 230, requestId: "req-1", revision: matchingRevision });
  const second = c.start({ issueNumber: 230, requestId: "req-2", revision: matchingRevision });
  second.catch(() => {});
  releaseRead();
  strictEqual((await first).started, true);
  await rejects(
    () => second,
    (error) => error.code === "busy",
  );
});

test("an incomplete tracker read refuses the start before anything is durable", async () => {
  const store = fakeStore();
  await rejects(
    () =>
      coordinator({
        store,
        tracker: fakeTracker(collectedIssue({ failed: true, revision: null, issue: null })),
      }).start({ issueNumber: 230, requestId: "req-1", revision: matchingRevision }),
    (error) => error.code === "context_unavailable",
  );
  strictEqual(store.calls.filter(([kind]) => kind !== "listRuns").length, 0);
});

const deniedSessions = (overrides = {}, log = []) =>
  fakeSessions(
    {
      start: async () => {
        throw Object.assign(
          new Error("the managed clarification runtime is not configured on this install"),
          { code: "runtime_unconfigured" },
        );
      },
      ...overrides,
    },
    log,
  );

test("a denied managed-session dispatch parks the run awaiting-human with the denial as evidence", async () => {
  const log = [];
  const store = fakeStore({}, log);
  const error = await coordinator({ store, sessions: deniedSessions({}, log) })
    .start({ issueNumber: 230, requestId: "req-1", revision: matchingRevision })
    .then(
      () => {
        throw new Error("expected the start to be denied");
      },
      (e) => e,
    );
  strictEqual(error.code, "start_denied");
  // The typed rejection carries the durable identity the Developer needs
  // to find the record again.
  strictEqual(error.runId, "run_1");
  strictEqual(error.attemptId, "attempt_1");

  // The denial is evidence, recorded under the live lease: the attempt's
  // result, the ledger event, the attempt closed terminal, the run parked
  // awaiting-human — Workbench dispatches nothing further on its own. The
  // terminal classification is published to the ledger only after the
  // durable record holds it.
  const kinds = log.map(([kind]) => kind);
  deepStrictEqual(kinds.slice(-5), [
    "recordAttemptResult",
    "appendEvent",
    "updateAttemptState",
    "updateRunState",
    "appendEvents",
  ]);
  const recorded = log.find(([kind]) => kind === "recordAttemptResult")[1];
  strictEqual(recorded.attemptId, "attempt_1");
  strictEqual(recorded.result.kind, "start-denied");
  strictEqual(recorded.result.code, "runtime_unconfigured");
  strictEqual(recorded.leaseToken, "lease_1");
  const deniedEvent = log.filter(([kind]) => kind === "appendEvent").at(-1)[1];
  strictEqual(deniedEvent.kind, "attempt.start-denied");
  strictEqual(deniedEvent.leaseToken, "lease_1");
  const attemptTransition = log.find(([kind]) => kind === "updateAttemptState")[1];
  strictEqual(attemptTransition.to, "terminal");
  strictEqual(attemptTransition.leaseToken, "lease_1");
  const runTransition = log.find(([kind]) => kind === "updateRunState")[1];
  strictEqual(runTransition.to, "awaiting-human");
  strictEqual(runTransition.leaseToken, "lease_1");
});

test("a fencing refusal on the denial path surfaces typed — a stale writer records nothing quietly", async () => {
  const store = fakeStore({
    recordAttemptResult: () => {
      throw Object.assign(new Error("the lease expired at ..."), { code: "lease_expired" });
    },
  });
  await rejects(
    () =>
      coordinator({ store, sessions: deniedSessions() }).start({
        issueNumber: 230,
        requestId: "req-1",
        revision: matchingRevision,
      }),
    (e) => e.code === "lease_expired",
  );
});

const durableRun = (overrides = {}) => ({
  runId: "run_1",
  hostRepo: "Quick-Release/workbench",
  issueId: "230",
  requestId: "req-1",
  state: "active",
  createdAt: "2026-09-18T10:00:01.000Z",
  updatedAt: "2026-09-18T10:00:01.000Z",
  ...overrides,
});

test("the run section reads lifecycle from durable snapshot reads, openly", async () => {
  const log = [];
  const store = fakeStore(
    {
      runs: [durableRun({ state: "awaiting-human" })],
      attempts: [
        {
          attemptId: "attempt_1",
          runId: "run_1",
          hostRepo: "Quick-Release/workbench",
          requestId: "req-1",
          dispatchIntent: {},
          state: "terminal",
          createdAt: "2026-09-18T10:00:03.000Z",
          updatedAt: "2026-09-18T10:00:04.000Z",
          result: { kind: "start-denied" },
        },
      ],
      getSnapshot: (runId) =>
        runId === "run_1"
          ? { snapshot: { lifecycle: "awaiting-human" }, savedAt: "2026-09-18T10:05:00.000Z" }
          : null,
      readEvents: (args) => {
        log.push(["readEvents", args]);
        return {
          events: [
            {
              cursor: args.afterCursor + 1,
              envelope: "clarification-events/v1",
              event: { type: "operational", kind: "run.started", data: {}, at: clock() },
            },
          ],
          latestCursor: 3,
        };
      },
    },
    log,
  );
  const section = await coordinator({ store }).runSection({ runId: "run_1", afterCursor: 2 });

  deepStrictEqual(section.run.runId, "run_1");
  deepStrictEqual(section.run.state, "awaiting-human");
  deepStrictEqual(
    section.attempts.map((a) => a.attemptId),
    ["attempt_1"],
  );
  deepStrictEqual(section.snapshot, { lifecycle: "awaiting-human" });
  strictEqual(section.snapshotSavedAt, "2026-09-18T10:05:00.000Z");
  strictEqual(section.latestCursor, 3);
  deepStrictEqual(section.events, [
    {
      cursor: 3,
      envelope: "clarification-events/v1",
      event: { type: "operational", kind: "run.started", data: {}, at: clock() },
    },
  ]);
  // The read is open: no lease token travels on it — a reconnecting viewer
  // never needs to own the run to catch up.
  const read = log.find(([kind]) => kind === "readEvents")[1];
  strictEqual(read.afterCursor, 2);
  deepStrictEqual(read.leaseToken, undefined);
});

test("an unknown run is a typed not-found, never an empty section", async () => {
  const store = fakeStore();
  await rejects(
    () => coordinator({ store }).runSection({ runId: "run_missing" }),
    (e) => e.code === "run_not_found",
  );
});

test("an expired cursor's explicit gap travels through the run section", async () => {
  const store = fakeStore({
    runs: [durableRun()],
    readEvents: ({ afterCursor }) =>
      afterCursor === 0
        ? { events: [], latestCursor: 0 }
        : {
            events: [],
            latestCursor: 9,
            gap: { after: 4, firstRetainedCursor: 9 },
          },
  });
  const section = await coordinator({ store }).runSection({ runId: "run_1", afterCursor: 4 });
  deepStrictEqual(section.gap, { after: 4, firstRetainedCursor: 9 });
  // No gap when the cursor is healthy — history is never dramatized.
  const healthy = await coordinator({ store }).runSection({ runId: "run_1", afterCursor: 0 });
  strictEqual(healthy.gap, undefined);
});

test("a request id already spent on another issue is a typed rejection, never the other run", async () => {
  const store = fakeStore({
    runs: [durableRun({ runId: "run_9", issueId: "231", requestId: "req-1" })],
  });
  await rejects(
    () =>
      coordinator({ store }).start({
        issueNumber: 230,
        requestId: "req-1",
        revision: matchingRevision,
      }),
    (error) => error.code === "request_reused",
  );
  // Nothing durable was touched answering the collision.
  strictEqual(store.calls.filter(([kind]) => kind !== "listRuns").length, 0);
});

test("the start denial evidence carries the coordinator clock's stamp", async () => {
  const log = [];
  const store = fakeStore({}, log);
  await coordinator({ store, sessions: deniedSessions({}, log) })
    .start({ issueNumber: 230, requestId: "req-1", revision: matchingRevision })
    .catch(() => {});
  const recorded = log.find(([kind]) => kind === "recordAttemptResult")[1];
  strictEqual(recorded.result.deniedAt, clock());
});

// The observation half, against the real SQLite store: every event is
// durable first, every viewer reads its own delta from the record.

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
    tracker: {
      readContext: async () => {
        throw new Error("the observation tier never reads the tracker");
      },
    },
    sessions: {
      start: async () => {
        throw new Error("the observation tier never starts a session");
      },
    },
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
  const { lease } = store.acquireLease({ runId: run.runId, owner: "test-controller" });
  const { attempt } = store.createAttempt({
    runId: run.runId,
    requestId: `${requestId}-attempt`,
    intent: { adapter: "pi-managed/v1" },
    leaseToken: lease.token,
  });
  return { run, attempt, lease };
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
    const { run, attempt, lease } = attemptRun(store, "r-ended");
    coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });
    store.updateAttemptState({
      attemptId: attempt.attemptId,
      to: "terminal",
      leaseToken: lease.token,
    });
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
    const { run, attempt, lease } = attemptRun(store, "r-detach");
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
    store.updateAttemptState({
      attemptId: attempt.attemptId,
      to: "awaiting-human",
      leaseToken: lease.token,
    });
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

// --- The conversation commands (spec #221, ticket #232): the Developer's
// explicit acts on one live attempt — prompt, steer, queue, clear-queue,
// stop-turn, dialogs — each deduplicated across reconnects and recorded as
// durable evidence around the runtime side effect it names. The scripted
// session fake stands in for the managed runtime: commands ride the same
// port the real adapter will satisfy, and acceptance stays the runtime's
// own signal, never the coordinator's assumption.

const scriptedSession = () => {
  const calls = [];
  const turns = [];
  const queue = [];
  const session = {
    calls,
    sessionId: "pi-session-scripted",
    state: () => "ready",
    turns,
    queue,
    sendPrompt: (text) => {
      // Like the adapter: one live turn at a time — a second prompt is a
      // synchronous typed refusal before any frame is written.
      if (turns.some((t) => !t.settled))
        throw Object.assign(
          new Error(
            "a prompt is already awaiting settlement — steer, queue it, or stop the turn first",
          ),
          { code: "turn_in_flight" },
        );
      calls.push(["sendPrompt", text]);
      const requestId = `req_${turns.length + 1}`;
      let accept;
      let settle;
      const accepted = new Promise((resolve, reject) => {
        accept = { resolve, reject };
      });
      const settled = new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
      const turn = {
        requestId,
        accept,
        settle,
        text,
        settled: false,
        // The runtime's settle: acceptance then settlement, the floor free
        // only after this.
        complete: () => {
          turn.accept.resolve();
          turn.settled = true;
          turn.settle.resolve();
        },
      };
      turns.push(turn);
      return { requestId, accepted, settled };
    },
    steer: (text) => {
      // Like the adapter: steering rides the live turn — with no turn in
      // flight it is a typed refusal before any frame is written.
      if (!turns.some((t) => !t.settled))
        throw Object.assign(new Error("no turn is live"), { code: "turn_not_in_flight" });
      calls.push(["steer", text]);
      const requestId = `req_steer_${calls.filter(([k]) => k === "steer").length}`;
      // The ack never lands in these tests; the coordinator disposes of it.
      const accepted = new Promise(() => {});
      return { requestId, accepted };
    },
    queueFollowUp: (text) => {
      // Like the adapter: a follow-up queues behind the live turn.
      if (!turns.some((t) => !t.settled))
        throw Object.assign(new Error("no turn is live"), { code: "turn_not_in_flight" });
      calls.push(["queueFollowUp", text]);
      const requestId = `req_queue_${calls.filter(([k]) => k === "queueFollowUp").length}`;
      // These promises never settle: the runtime delivers a queued entry as
      // its own turn, which these tests model only through stop/clear.
      const accepted = new Promise(() => {});
      const settled = new Promise(() => {});
      const entry = { requestId, text, settledFlag: false };
      queue.push(entry);
      return { requestId, accepted, settled };
    },
    clearQueue: () => {
      calls.push(["clearQueue"]);
      const cleared = queue
        .splice(0)
        .map((entry) => ({ requestId: entry.requestId, text: entry.text }));
      return { cleared };
    },
    stopTurn: () => {
      const live = turns.find((t) => !t.settled);
      if (live === undefined)
        throw Object.assign(new Error("no turn is live"), { code: "turn_not_in_flight" });
      calls.push(["stopTurn"]);
      // The adapter's order: the queue clears FIRST, then the abort rides
      // the wire. The live turn's settle becomes its cancelled outcome.
      const cleared = queue
        .splice(0)
        .map((entry) => ({ requestId: entry.requestId, text: entry.text }));
      live.settled = true;
      live.accept.reject(
        Object.assign(new Error("the turn was explicitly stopped"), { code: "cancelled" }),
      );
      live.settle.reject(
        Object.assign(new Error("the turn was explicitly stopped"), { code: "cancelled" }),
      );
      return { requestId: "req_abort_1", cleared };
    },
    answerDialog: (args) => {
      calls.push(["answerDialog", args]);
      return { dialogId: args.dialogId, answered: true };
    },
    cancelDialog: (args) => {
      calls.push(["cancelDialog", args]);
      return { dialogId: args.dialogId, cancelled: true };
    },
    // The streaming port: frames the test emits land in a queue the
    // coordinator's pump consumes — the same contract the managed adapter
    // satisfies with its retained event buffer.
    emit: (event) => {
      const frame = { cursor: session.frames.length + 1, envelope: "pi-managed/v1", event };
      session.frames.push(frame);
      for (const wake of session.frameWaiters.splice(0)) wake();
      return frame;
    },
    frames: [],
    frameWaiters: [],
    closed: false,
    subscribe: async function* (fromCursor) {
      let last = fromCursor;
      while (true) {
        for (const frame of session.frames) {
          if (frame.cursor > last) {
            last = frame.cursor;
            yield frame;
          }
        }
        if (session.closed) return;
        await new Promise((resolve) => session.frameWaiters.push(resolve));
      }
    },
    pendingDialogs: () => [],
    unsupportedCapabilities: () => [],
  };
  return session;
};

// A coordinator whose attempt is started against a scripted session: the
// full start path runs for real (durable run, lease, attempt), so every
// conversation test begins from the record a real start leaves behind.
const withLiveConversation = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-clarification-conversation-"));
  const databasePath = join(directory, "runs.sqlite");
  const store = openClarificationStore({
    hostRepo: "example/project",
    databasePath,
    clock: () => "2026-09-18T00:00:00Z",
  });
  const session = scriptedSession();
  const coordinator = createClarificationCoordinator({
    store,
    clock: () => "2026-09-18T00:00:00Z",
    tracker: fakeTracker(collectedIssue()),
    sessions: {
      start: async () => session,
    },
  });
  try {
    const { run, attempt } = await coordinator.start({
      issueNumber: 230,
      requestId: "start-req-1",
      revision: {
        updatedAt: "2026-09-18T10:00:00.000Z",
        bodyHash: "sha-256:abc",
      },
    });
    return await fn({ coordinator, store, session, run, attempt });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
};

test("a prompt dispatches once and the replay is answered from the record, never re-sent", async () => {
  await withLiveConversation(async ({ coordinator, session, run, attempt }) => {
    const turn = session.calls.length;
    const first = await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-1",
      text: "what does this issue need clarified?",
    });
    strictEqual(first.sent, true);
    strictEqual(session.calls.length, turn + 1);
    deepStrictEqual(session.calls.at(-1), ["sendPrompt", "what does this issue need clarified?"]);

    // The prompt is durable evidence before the replay arrives: the
    // operational ledger carries the client request id, so a reconnect
    // replay is answered from the record — the runtime never sees it twice.
    const replay = await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-1",
      text: "what does this issue need clarified?",
    });
    strictEqual(replay.sent, false);
    strictEqual(session.calls.length, turn + 1);
  });
});

test("a prompt while a turn is live is a typed refusal with the refusal as evidence", async () => {
  await withLiveConversation(async ({ coordinator, session, store, run, attempt }) => {
    const first = await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-1",
      text: "first",
    });
    strictEqual(first.sent, true);

    // The floor is busy: the second prompt is refused typed, and the
    // refusal lands in the ledger — intent, then refusal — so the record
    // never claims a dispatch that did not happen.
    throws(
      () =>
        coordinator.sendPrompt({
          runId: run.runId,
          attemptId: attempt.attemptId,
          requestId: "client-prompt-2",
          text: "second",
        }),
      (error) => error.code === "turn_in_flight",
    );
    const kinds = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.filter(({ event }) => event.type === "operational")
      .map(({ event }) => event.kind);
    deepStrictEqual(kinds, [
      "run.started",
      "attempt.recorded",
      "conversation.prompt",
      "conversation.prompt",
      "conversation.prompt-refused",
    ]);

    // The refused request id is spent: a replay answers from the record,
    // and the runtime still saw only the first prompt.
    const replay = await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-2",
      text: "second",
    });
    strictEqual(replay.sent, false);
    strictEqual(session.calls.filter(([kind]) => kind === "sendPrompt").length, 1);
  });
});

test("steer and queue are explicit, distinct acts with their own evidence", async () => {
  await withLiveConversation(async ({ coordinator, session, store, run, attempt }) => {
    await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-1",
      text: "first",
    });

    // Steer rides the live turn: its evidence names the guidance, and the
    // runtime received exactly that.
    const steer = await coordinator.steer({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-steer-1",
      text: "keep it about the acceptance criteria",
    });
    strictEqual(steer.sent, true);
    deepStrictEqual(session.calls.at(-1), ["steer", "keep it about the acceptance criteria"]);

    // A follow-up queues behind the live turn: explicitly held work, not a
    // second prompt.
    const queued = await coordinator.queueFollowUp({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-follow-up-1",
      text: "then list the open questions",
    });
    strictEqual(queued.sent, true);
    deepStrictEqual(session.calls.at(-1), ["queueFollowUp", "then list the open questions"]);

    // Each act is its own operational evidence, in the order it happened.
    const kinds = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.filter(({ event }) => event.type === "operational")
      .map(({ event }) => event.kind);
    deepStrictEqual(kinds, [
      "run.started",
      "attempt.recorded",
      "conversation.prompt",
      "conversation.steer",
      "conversation.follow-up-queued",
    ]);

    // Both deduplicate on their own request ids across reconnects.
    strictEqual(
      (
        await coordinator.steer({
          runId: run.runId,
          attemptId: attempt.attemptId,
          requestId: "client-steer-1",
          text: "keep it about the acceptance criteria",
        })
      ).sent,
      false,
    );
    strictEqual(
      (
        await coordinator.queueFollowUp({
          runId: run.runId,
          attemptId: attempt.attemptId,
          requestId: "client-follow-up-1",
          text: "then list the open questions",
        })
      ).sent,
      false,
    );
    strictEqual(session.calls.filter(([kind]) => kind === "steer").length, 1);
    strictEqual(session.calls.filter(([kind]) => kind === "queueFollowUp").length, 1);
  });
});

test("stop-turn clears the queue first and the stop names the cleared work", async () => {
  await withLiveConversation(async ({ coordinator, session, store, run, attempt }) => {
    await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-1",
      text: "first",
    });
    await coordinator.queueFollowUp({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-follow-up-1",
      text: "queued one",
    });
    await coordinator.queueFollowUp({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-follow-up-2",
      text: "queued two",
    });

    const stopped = coordinator.stopTurn({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-stop-1",
    });
    strictEqual(stopped.sent, true);
    deepStrictEqual(stopped.cleared, [
      { requestId: "req_queue_1", text: "queued one" },
      { requestId: "req_queue_2", text: "queued two" },
    ]);
    // The queue cleared before the abort rode the wire — the adapter's
    // order, asserted on the runtime side.
    const stopIndex = session.calls.findIndex(([kind]) => kind === "stopTurn");
    ok(stopIndex !== -1);
    strictEqual(session.calls.length, stopIndex + 1);

    // The stop's ledger evidence names exactly what was cleared with it —
    // work that will never deliver is visible as never delivered.
    const stopEvent = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.map(({ event }) => event)
      .filter((event) => event.type === "operational" && event.kind === "conversation.turn-stopped")
      .at(-1);
    deepStrictEqual(stopEvent.data.cleared, [
      { requestId: "req_queue_1", text: "queued one" },
      { requestId: "req_queue_2", text: "queued two" },
    ]);

    // The floor is free again: the next prompt dispatches.
    const next = await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-2",
      text: "second",
    });
    strictEqual(next.sent, true);

    // The stop's request id is spent: a replayed stop answers from the
    // record and never aborts the new turn.
    const replay = coordinator.stopTurn({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-stop-1",
    });
    strictEqual(replay.sent, false);
    strictEqual(session.calls.filter(([kind]) => kind === "stopTurn").length, 1);
  });
});

test("dialogs answer typed and the conversation state surfaces them as questions", async () => {
  await withLiveConversation(async ({ coordinator, session, store, run, attempt }) => {
    // The runtime asks a typed question: a select dialog pending.
    const dialog = {
      dialogId: "dialog_1",
      kind: "select",
      request: { type: "select", options: ["a", "b"] },
    };
    session.pendingDialogs = () => [dialog];

    const state = coordinator.conversationState({ runId: run.runId, attemptId: attempt.attemptId });
    strictEqual(state.available, true);
    strictEqual(state.sessionState, "ready");
    deepStrictEqual(state.pendingDialogs, [dialog]);

    // The Developer's answer is evidence: what was asked, what was answered.
    const answered = coordinator.answerDialog({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-answer-1",
      dialogId: "dialog_1",
      value: "a",
    });
    strictEqual(answered.sent, true);
    deepStrictEqual(session.calls.at(-1), ["answerDialog", { dialogId: "dialog_1", value: "a" }]);
    const answeredEvent = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.map(({ event }) => event)
      .filter(
        (event) => event.type === "operational" && event.kind === "conversation.dialog-answered",
      )
      .at(-1);
    deepStrictEqual(answeredEvent.data, {
      attemptId: attempt.attemptId,
      requestId: "client-answer-1",
      dialogId: "dialog_1",
      value: "a",
    });

    // A cancelled dialog is a typed cancellation, never a default answer.
    session.pendingDialogs = () => [];
    const cancelled = coordinator.cancelDialog({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-cancel-1",
      dialogId: "dialog_2",
    });
    strictEqual(cancelled.sent, true);
    deepStrictEqual(session.calls.at(-1), ["cancelDialog", { dialogId: "dialog_2" }]);

    // Both deduplicate on their request ids.
    strictEqual(
      coordinator.answerDialog({
        runId: run.runId,
        attemptId: attempt.attemptId,
        requestId: "client-answer-1",
        dialogId: "dialog_1",
        value: "a",
      }).sent,
      false,
    );
  });
});

test("unsupported widgets surface as the capability list, never a silent drop", async () => {
  await withLiveConversation(async ({ coordinator, session, run, attempt }) => {
    session.unsupportedCapabilities = () => [
      {
        capability: "custom-widget",
        count: 2,
        frame: { type: "extension_widget", widget: "custom-widget" },
      },
    ];
    const state = coordinator.conversationState({ runId: run.runId, attemptId: attempt.attemptId });
    deepStrictEqual(state.unsupportedCapabilities, [
      {
        capability: "custom-widget",
        count: 2,
        frame: { type: "extension_widget", widget: "custom-widget" },
      },
    ]);
  });
});

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("a two-turn conversation streams text and tool frames as durable evidence, in context", async () => {
  await withLiveConversation(async ({ coordinator, session, store, run, attempt }) => {
    // Turn one: the prompt, the runtime's ack, streamed text and a tool
    // activity frame, then settlement.
    await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-1",
      text: "first question",
    });
    session.emit({ type: "accepted", id: "req_1" });
    session.emit({ type: "message_update", text: "reading the issue…" });
    session.emit({ type: "tool_execution", tool: "read_file", input: { path: "CONTEXT.md" } });
    session.emit({ type: "message_update", text: "the issue asks for X" });
    session.turns[0].complete();

    // Turn two on the same session: context carries.
    await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-2",
      text: "follow-up question",
    });
    session.emit({ type: "accepted", id: "req_2" });
    session.emit({ type: "message_update", text: "answering from what I read before" });
    session.turns[1].complete();
    await settle();

    // Every runtime frame is durable conversation evidence, in order, each
    // wrapped in the ledger's own envelope.
    const conversation = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.filter(({ event }) => event.type === "conversation")
      .map(({ event }) => event);
    strictEqual(conversation.length, 6);
    for (const event of conversation) {
      strictEqual(event.attemptId, attempt.attemptId);
      ok(event.session.cursor >= 1);
      strictEqual(event.session.envelope, "pi-managed/v1");
    }
    deepStrictEqual(
      conversation.map(({ session: { event } }) => event.type),
      [
        "accepted",
        "message_update",
        "tool_execution",
        "message_update",
        "accepted",
        "message_update",
      ],
    );

    // The run section serves the same conversation — a reconnecting viewer
    // gets both turns back, never a re-send of either prompt.
    const section = await coordinator.runSection({ runId: run.runId, afterCursor: 0 });
    deepStrictEqual(section.events.filter(({ event }) => event.type === "conversation").length, 6);
    strictEqual(section.run.runId, run.runId);
    // One session carried both turns.
    strictEqual(session.calls.filter(([kind]) => kind === "sendPrompt").length, 2);
  });
});

test("the run for an issue is findable for the surface's reconnect-after-refresh", async () => {
  await withLiveConversation(async ({ coordinator, store, run }) => {
    const found = await coordinator.runForIssue({ issueNumber: 230 });
    strictEqual(found.runId, run.runId);
    // No run for an untouched issue is an honest null, not an error.
    strictEqual(await coordinator.runForIssue({ issueNumber: 231 }), null);

    // An unknown issue number is a typed invalid request, like the manifest.
    await rejects(
      () => coordinator.runForIssue({ issueNumber: -1 }),
      (error) => error.code === "invalid_request",
    );
    ok(store !== null);
  });
});
