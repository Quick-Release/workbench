import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClarificationCoordinator } from "./coordinator.mjs";
import { openClarificationStore } from "./store.mjs";
import { noApprovalLine } from "../../../src/types.ts";

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
    getLease: (runId) => {
      calls.push(["getLease", { runId }]);
      return null;
    },
    usageBudgetFor: (runId) => {
      calls.push(["usageBudgetFor", { runId }]);
      return { runId, lines: [] };
    },
    listEscalations: (runId) => {
      calls.push(["listEscalations", { runId }]);
      return [];
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

const withCoordinator = async (fn, { eventLedgerLimit, tracker, sessions } = {}) => {
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
    tracker: tracker ?? {
      readContext: async () => {
        throw new Error("the observation tier never reads the tracker");
      },
    },
    sessions: sessions ?? {
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

test("a dispatch the runtime never accepts lands in the ledger as failure evidence", async () => {
  await withLiveConversation(async ({ coordinator, session, store, run, attempt }) => {
    await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-1",
      text: "first",
    });

    // The runtime takes the frame but rejects the ack: the ledger already
    // holds the intent, so the uncertainty becomes typed evidence too.
    session.turns[0].accept.reject(Object.assign(new Error("provider quota"), { code: "quota" }));
    await settle();

    const failure = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.map(({ event }) => event)
      .filter(
        (event) => event.type === "operational" && event.kind === "conversation.prompt-failed",
      )
      .at(-1);
    ok(failure !== undefined);
    deepStrictEqual(failure.data, {
      attemptId: attempt.attemptId,
      requestId: "client-prompt-1",
      code: "quota",
    });
  });
});

test("command evidence wakes live viewers the moment it is durable", async () => {
  await withLiveConversation(async ({ coordinator, run, attempt }) => {
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
    // Drain the start's replay: run.started, attempt.recorded, active.
    for (let i = 0; i < 3; i += 1) await read();

    // The stream is waiting; a fenced command write must reach it without
    // any publication event riding along.
    const pending = read();
    await coordinator.sendPrompt({
      runId: run.runId,
      attemptId: attempt.attemptId,
      requestId: "client-prompt-9",
      text: "hello the stream",
    });
    strictEqual(await pending, false);
    const last = frames.at(-1);
    strictEqual(last.event.type, "operational");
    strictEqual(last.event.kind, "conversation.prompt");
    stream.return();
  });
});

test("the run for an issue is findable for the surface's reconnect", async () => {
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

// --- The Clarification draft (spec #221, ticket #233): the attempt's
// --- proposal, saved through the coordinator, read back with its brief
// --- completeness arithmetic and the visible issue-body diff.

const draftDocument = (overrides = {}) => ({
  version: "clarification-draft/v1",
  profile: "bug",
  behavior: "the sync command exits 0 on a clean tree",
  observation: "it exits 1 with a lockfile warning",
  reproduction: "run pnpm sync on a clean checkout",
  boundary: "",
  scope: "scripts/sync only",
  exclusions: ["the pack-smoke harness"],
  acceptance: ["sync exits 0 on a clean tree"],
  dependencies: "",
  performanceClaim: "",
  performanceEvidence: "",
  assumptions: [],
  evidence: [],
  ...overrides,
});

const issueRead = collectedIssue({
  issue: { number: 42, title: "Clarification draft", body: "old body", state: "OPEN" },
});

// A live coordinator for the draft tier: a startable managed session, a
// tracker that answers, the real SQLite store underneath.
const liveSessions = () => fakeSessions();

const startClarification = async (coordinator, issueNumber = 42, requestId = "r-draft") =>
  coordinator.start({
    issueNumber,
    requestId,
    revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
  });

test("saving a draft persists it; the read answers completeness and the visible diff", async () => {
  await withCoordinator(
    async ({ coordinator }) => {
      const started = await startClarification(coordinator);
      const runId = started.run.runId;
      const attemptId = started.attempt.attemptId;
      const draft = draftDocument();

      const saved = await coordinator.saveDraft({ runId, attemptId, draft });
      deepStrictEqual(saved.draft, draft);
      deepStrictEqual(saved.gaps, []);
      strictEqual(saved.briefCompleteness, "ready");
      strictEqual(saved.savingIsNotApproval, noApprovalLine);
      strictEqual(saved.issue.body, "old body");
      // The diff renders exactly the bytes publication would write.
      deepStrictEqual(saved.diff.lines[0], { kind: "removed", text: "old body" });
      ok(saved.diff.lines.some((line) => line.kind === "added" && line.text === "## Behavior"));
      ok(saved.savedAt);

      // The read answers the same from the durable record.
      const view = await coordinator.draftView({ runId, attemptId });
      deepStrictEqual(view.draft, draft);
      deepStrictEqual(view.gaps, []);
      strictEqual(view.briefCompleteness, "ready");
    },
    { tracker: fakeTracker(issueRead), sessions: liveSessions() },
  );
});

test("a draft read before any save is needs-information on the no-draft gap", async () => {
  await withCoordinator(
    async ({ coordinator }) => {
      const started = await startClarification(coordinator);
      const view = await coordinator.draftView({
        runId: started.run.runId,
        attemptId: started.attempt.attemptId,
      });
      strictEqual(view.draft, null);
      deepStrictEqual(view.gaps, ["no Clarification draft exists yet"]);
      strictEqual(view.briefCompleteness, "needs-information");
      strictEqual(view.diff, null);
      // The issue base still answers, so the panel can show what a draft
      // would differ from; only the diff withholds.
      strictEqual(view.issue.body, "old body");
    },
    { tracker: fakeTracker(issueRead), sessions: liveSessions() },
  );
});

test("a failed tracker read leaves the draft readable, the diff honestly absent", async () => {
  let result = issueRead;
  const tracker = {
    readContext: async () => result,
  };
  await withCoordinator(
    async ({ coordinator }) => {
      const started = await startClarification(coordinator);
      const runId = started.run.runId;
      const attemptId = started.attempt.attemptId;
      await coordinator.saveDraft({ runId, attemptId, draft: draftDocument() });

      result = collectedIssue({ failed: true, revision: null, issue: null });
      const view = await coordinator.draftView({ runId, attemptId });
      ok(view.draft);
      strictEqual(view.issue, null);
      strictEqual(view.diff, null);
      ok(view.warnings.length > 0);
    },
    { tracker, sessions: liveSessions() },
  );
});

test("a draft save moves no lifecycle state and records its evidence in the ledger", async () => {
  await withCoordinator(
    async ({ coordinator, store }) => {
      const started = await startClarification(coordinator);
      const runId = started.run.runId;
      const attemptId = started.attempt.attemptId;
      await coordinator.saveDraft({
        runId,
        attemptId,
        draft: draftDocument({ profile: "unknown" }),
      });

      // Saving a draft is not approval, and not a lifecycle act: nothing
      // about the run or the attempt moved.
      strictEqual(store.getRun(runId).state, "active");
      strictEqual(store.getAttempt(attemptId).state, "active");

      const saved = store
        .readEvents({ runId, afterCursor: 0 })
        .events.map(({ event }) => event)
        .find((event) => event.type === "operational" && event.kind === "draft.saved");
      ok(saved);
      strictEqual(saved.data.attemptId, attemptId);
      strictEqual(saved.data.profile, "unknown");
    },
    { tracker: fakeTracker(issueRead), sessions: liveSessions() },
  );
});

test("a draft save is fenced typed while another writer holds the controller lease", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-fenced");
    await rejects(
      () =>
        coordinator.saveDraft({
          runId: run.runId,
          attemptId: attempt.attemptId,
          draft: draftDocument(),
        }),
      (error) => error.code === "busy",
    );
    // The read stays open like every read.
    const view = await coordinator.draftView({ runId: run.runId, attemptId: attempt.attemptId });
    strictEqual(view.draft, null);
  });
});

test("an invalid draft is refused typed and nothing is written", async () => {
  await withCoordinator(
    async ({ coordinator, store }) => {
      const started = await startClarification(coordinator);
      const runId = started.run.runId;
      const attemptId = started.attempt.attemptId;
      await rejects(
        () =>
          coordinator.saveDraft({
            runId,
            attemptId,
            draft: { version: "clarification-draft/v1", profile: "bug" },
          }),
        (error) => error.code === "invalid_draft",
      );
      strictEqual(store.getDraft(attemptId), null);
      const recorded = store
        .readEvents({ runId, afterCursor: 0 })
        .events.some(({ event }) => event.type === "operational" && event.kind === "draft.saved");
      strictEqual(recorded, false);
    },
    { tracker: fakeTracker(issueRead), sessions: liveSessions() },
  );
});

test("a draft on an unknown run, or an attempt of another run, is a typed not-found", async () => {
  await withCoordinator(
    async ({ coordinator }) => {
      const started = await startClarification(coordinator);
      await rejects(
        () => coordinator.draftView({ runId: "run_missing", attemptId: started.attempt.attemptId }),
        (error) => error.code === "run_not_found",
      );
      await rejects(
        () => coordinator.draftView({ runId: started.run.runId, attemptId: "attempt_missing" }),
        (error) => error.code === "attempt_not_found",
      );
      await rejects(
        () =>
          coordinator.saveDraft({
            runId: started.run.runId,
            attemptId: "attempt_missing",
            draft: draftDocument(),
          }),
        (error) => error.code === "attempt_not_found",
      );
      const second = await startClarification(coordinator, 43, "r-second");
      await rejects(
        () =>
          coordinator.draftView({ runId: second.run.runId, attemptId: started.attempt.attemptId }),
        (error) => error.code === "attempt_not_found",
      );
    },
    { tracker: fakeTracker(issueRead), sessions: liveSessions() },
  );
});

// --- Ticket #235: the failure policy (ADR 0023). Fake-port tests order the
// coordinator's policy mutations and rejections; the store-backed tests
// prove the durable behavior end to end. ---

// The policy port surface layered on the fake store: the outcome command's
// durable neighbors, each recording its call like the base fake does. The
// signature counter is real enough to cross the halt bound, and the run
// state is overridable so the retry gate's refusals can be exercised.
const policyStore = (
  { signatureCount = 1, runState = null, attempts = [], runs = [], overrides = {} } = {},
  log = [],
) => {
  // The policy commands act on an existing attempt; a test that does not
  // name one gets the record a settled start would have left.
  const knownAttempts =
    attempts.length > 0
      ? attempts
      : [
          {
            attemptId: "attempt_1",
            runId: "run_1",
            requestId: "start-req-1",
            state: "active",
            result: null,
          },
        ];
  const knownRuns =
    runs.length > 0
      ? runs
      : [
          {
            runId: "run_1",
            hostRepo: "Quick-Release/workbench",
            issueId: "230",
            requestId: "start-req-1",
            state: "active",
          },
        ];
  const base = fakeStore({ attempts: knownAttempts, runs: knownRuns }, log);
  const budgetLines = [];
  const store = {
    ...base,
    // The base fake answers reads by list only; the policy commands look an
    // attempt up by id.
    getAttempt: (attemptId) => knownAttempts.find((a) => a.attemptId === attemptId) ?? null,
    // The base fake's log narrows to the start's fields; the policy needs
    // the origin it passed.
    createAttempt: (args) => {
      log.push(["createAttempt", args]);
      const replayed = knownAttempts.find(
        (a) => a.runId === args.runId && a.requestId === args.requestId,
      );
      if (replayed) return { attempt: replayed, created: false };
      const attempt = {
        attemptId: `attempt_${knownAttempts.length + 1}`,
        runId: args.runId,
        hostRepo: "Quick-Release/workbench",
        requestId: args.requestId,
        dispatchIntent: args.intent,
        state: "active",
        origin: args.origin,
        result: null,
      };
      knownAttempts.push(attempt);
      return { attempt, created: true };
    },
    renewLease: (args) => {
      log.push(["renewLease", args]);
    },
    recordAttemptOutcome: (args) => {
      log.push(["recordAttemptOutcome", args]);
      return store.getAttempt(args.attemptId);
    },
    markAttemptDispatched: (args) => {
      log.push(["markAttemptDispatched", args]);
      return store.getAttempt(args.attemptId);
    },
    recordFailureSignature: ({ runId, signature, attemptId }) => {
      log.push(["recordFailureSignature", { runId, signature, attemptId }]);
      return { count: signatureCount };
    },
    haltRun: (args) => {
      log.push(["haltRun", args]);
      return { record: args.record, moved: true };
    },
    appendUsageLines: (args) => {
      log.push(["appendUsageLines", args]);
      const stored = args.lines.map((line, index) => ({
        lineId: `usage_${budgetLines.length + index + 1}`,
        ...line,
      }));
      budgetLines.push(...stored);
      return stored;
    },
    usageBudgetFor: (runId) => {
      log.push(["usageBudgetFor", { runId }]);
      return { runId, lines: [...budgetLines] };
    },
  };
  if (runState !== null)
    store.getRun = (runId) => {
      const run = base.getRun(runId);
      return run === null ? null : { ...run, state: runState };
    };
  // A test's explicit store overrides win, applied last.
  return { ...store, ...overrides };
};

test("a quota outcome parks the attempt awaiting-human and folds its usage", () => {
  const log = [];
  const store = policyStore({}, log);
  coordinator({ store }).recordOutcome({
    runId: "run_1",
    attemptId: "attempt_1",
    outcome: { kind: "provider-failure", reason: "quota", usage: { total: 12 } },
  });

  const outcomeCall = log.find(([kind]) => kind === "recordAttemptOutcome")[1];
  strictEqual(outcomeCall.to, "awaiting-human");
  strictEqual(outcomeCall.result.kind, "provider-failure");
  strictEqual(outcomeCall.result.classification, "known-failure");
  strictEqual(outcomeCall.result.nextAction, "await-human");
  strictEqual(outcomeCall.event.kind, "attempt.outcome");
  deepStrictEqual(outcomeCall.event.data.usage, { total: 12 });
  ok(typeof outcomeCall.leaseToken === "string");

  const usage = log.find(([kind]) => kind === "appendUsageLines")[1];
  deepStrictEqual(usage.lines, [
    { kind: "reported", unit: "provider", detail: { total: 12 }, attemptId: "attempt_1" },
  ]);

  // One identical signature is recorded; nothing halts yet.
  const signatureCall = log.find(([kind]) => kind === "recordFailureSignature")[1];
  ok(signatureCall.signature.length > 0);
  strictEqual(
    log.some(([kind]) => kind === "haltRun"),
    false,
  );
});

test("a second identical failure signature halts the run with an escalation record", () => {
  const log = [];
  const store = policyStore({ signatureCount: 2 }, log);
  const verdict = coordinator({ store }).recordOutcome({
    runId: "run_1",
    attemptId: "attempt_1",
    outcome: { kind: "provider-failure", reason: "quota" },
  });
  strictEqual(verdict.halted, true);
  strictEqual(verdict.nextAction, "await-human");

  const halt = log.find(([kind]) => kind === "haltRun")[1];
  strictEqual(halt.record.repeats, 2);
  strictEqual(halt.record.reason, "quota");
  deepStrictEqual(halt.record.remainingAuthority, ["manual-retry"]);
  ok(halt.record.decision.length > 0);
  ok(halt.record.signature.length > 0);
});

test("a reason-less failure escalates without a null reason", () => {
  const log = [];
  const store = policyStore({ signatureCount: 2 }, log);
  coordinator({ store }).recordOutcome({
    runId: "run_1",
    attemptId: "attempt_1",
    outcome: { kind: "rejected", evidence: { error: "bad prompt" } },
  });
  const halt = log.find(([kind]) => kind === "haltRun")[1];
  strictEqual("reason" in halt.record, false);
  strictEqual(halt.record.classification, "known-failure");
});

test("an already-escalated signature stands: the halt is idempotent", () => {
  const log = [];
  const store = policyStore(
    {
      signatureCount: 2,
      overrides: {
        haltRun: () => {
          log.push(["haltRun", {}]);
          throw Object.assign(new Error("already escalated"), { code: "already_halted" });
        },
      },
    },
    log,
  );
  const verdict = coordinator({ store }).recordOutcome({
    runId: "run_1",
    attemptId: "attempt_1",
    outcome: { kind: "provider-failure", reason: "quota" },
  });
  strictEqual(verdict.halted, false);
  strictEqual(log.filter(([kind]) => kind === "haltRun").length, 1);
});

test("an outcome the policy cannot classify is a typed rejection that writes nothing", () => {
  const log = [];
  const store = policyStore({}, log);
  throws(
    () =>
      coordinator({ store }).recordOutcome({
        runId: "run_1",
        attemptId: "attempt_1",
        outcome: { kind: "vibes" },
      }),
    (error) => error.code === "invalid_outcome",
  );
  strictEqual(
    log.some(([kind]) => kind === "recordAttemptOutcome"),
    false,
  );
  strictEqual(
    log.some(([kind]) => kind === "appendUsageLines"),
    false,
  );
});

test("the coordinator retry fires once on a start denial, with its decision as evidence", () => {
  const log = [];
  const failed = {
    attemptId: "attempt_1",
    runId: "run_1",
    requestId: "start-req-1",
    state: "terminal",
    result: { kind: "start-denied", code: "runtime_ended", deniedAt: clock() },
  };
  const store = policyStore({ attempts: [failed] }, log);
  const { attempt, created } = coordinator({ store }).requestCoordinatorRetry({
    runId: "run_1",
    fromAttemptId: "attempt_1",
    requestId: "retry-req-1",
    intent: { kind: "clarification-retry" },
  });
  strictEqual(created, true);
  // The fresh attempt is a new identity, never the failed one's.
  ok(attempt.attemptId !== "attempt_1");

  const createdCall = log.find(([kind]) => kind === "createAttempt")[1];
  strictEqual(createdCall.origin, "coordinator-retry");
  deepStrictEqual(createdCall.intent, { kind: "clarification-retry" });

  const event = log.find(([kind]) => kind === "appendEvent")[1];
  strictEqual(event.kind, "attempt.coordinator-retried");
  strictEqual(event.data.fromAttemptId, "attempt_1");
  strictEqual(event.data.basis, "proven-non-dispatch");
});

test("the coordinator retry refuses every outcome that does not prove non-dispatch", () => {
  const refusals = [
    { result: null, why: "no recorded outcome" },
    { result: { kind: "outcome", classification: "known-failure" }, why: "recorded outcome" },
    { result: { kind: "provider-failure", reason: "quota" }, why: "provider failure" },
    { result: { kind: "cancelled" }, why: "cancellation" },
  ];
  for (const refusal of refusals) {
    const log = [];
    const store = policyStore(
      {
        attempts: [
          {
            attemptId: "attempt_1",
            runId: "run_1",
            requestId: "start-req-1",
            state: "terminal",
            result: refusal.result,
          },
        ],
      },
      log,
    );
    throws(
      () =>
        coordinator({ store }).requestCoordinatorRetry({
          runId: "run_1",
          fromAttemptId: "attempt_1",
          requestId: "retry-req-1",
          intent: {},
        }),
      (error) => error.code === "retry_not_eligible",
      refusal.why,
    );
    strictEqual(
      log.some(([kind]) => kind === "createAttempt"),
      false,
      refusal.why,
    );
  }

  // The lying-reporter fence: an attempt marked dispatched can never ground
  // a non-dispatch retry, whatever its outcome claims.
  const log = [];
  const store = policyStore(
    {
      attempts: [
        {
          attemptId: "attempt_1",
          runId: "run_1",
          requestId: "start-req-1",
          state: "terminal",
          result: { kind: "start-denied", code: "runtime_ended" },
          dispatchedAt: clock(),
        },
      ],
    },
    log,
  );
  throws(
    () =>
      coordinator({ store }).requestCoordinatorRetry({
        runId: "run_1",
        fromAttemptId: "attempt_1",
        requestId: "retry-req-1",
        intent: {},
      }),
    (error) => error.code === "retry_not_eligible",
  );
  strictEqual(
    log.some(([kind]) => kind === "createAttempt"),
    false,
  );

  // A halted run dispatches nothing, coordinator retry included.
  const halted = policyStore({ runState: "awaiting-human" });
  throws(
    () =>
      coordinator({ store: halted }).requestCoordinatorRetry({
        runId: "run_1",
        fromAttemptId: "attempt_1",
        requestId: "retry-req-1",
        intent: {},
      }),
    (error) => error.code === "run_not_active",
  );
});

test("usage lines through the coordinator keep their kinds distinct forever", () => {
  const log = [];
  const store = policyStore({}, log);
  coordinator({ store }).recordUsage({
    runId: "run_1",
    line: { kind: "reported", unit: "usd", value: 0.25 },
  });
  coordinator({ store }).recordUsage({
    runId: "run_1",
    line: { kind: "estimated", unit: "usd", value: 10 },
  });
  coordinator({ store }).recordUsage({ runId: "run_1", line: { kind: "unknown", unit: "usd" } });

  throws(
    () =>
      coordinator({ store }).recordUsage({
        runId: "run_1",
        line: { kind: "unknown", unit: "usd", value: 5 },
      }),
    (error) => error.code === "invalid_usage_line",
  );
  throws(
    () =>
      coordinator({ store }).recordUsage({
        runId: "run_1",
        line: { kind: "guessed", unit: "usd", value: 1 },
      }),
    (error) => error.code === "invalid_usage_line",
  );

  const budget = coordinator({ store }).usageBudget({ runId: "run_1" });
  deepStrictEqual(budget.totals, {
    reported: { usd: 0.25 },
    estimated: { usd: 10 },
    unknownLines: 1,
  });
});

// --- Store-backed policy tests: the durable behavior, end to end. ---

test("a quota outcome parks awaiting-human, folds its usage, and the record surfaces it", async () => {
  await withLiveConversation(async ({ coordinator, store, run, attempt }) => {
    coordinator.recordUsage({
      runId: run.runId,
      attemptId: attempt.attemptId,
      line: { kind: "estimated", unit: "tokens", value: 500 },
    });

    const verdict = coordinator.recordOutcome({
      runId: run.runId,
      attemptId: attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota", usage: { total: 12 } },
    });
    strictEqual(verdict.classification, "known-failure");
    strictEqual(verdict.nextAction, "await-human");
    strictEqual(verdict.halted, false);
    strictEqual(store.getAttempt(attempt.attemptId).state, "awaiting-human");
    // Nothing automatic happened beyond the park: the run stays active.
    strictEqual(store.getRun(run.runId).state, "active");

    // The outcome's operational event is on the ledger; the budget carries
    // the pre-park estimate and the provider-reported usage verbatim.
    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    const outcomeEvent = events
      .map((envelope) => envelope.event)
      .find((event) => event.kind === "attempt.outcome");
    strictEqual(outcomeEvent.data.reason, "quota");
    deepStrictEqual(outcomeEvent.data.usage, { total: 12 });
    const budget = coordinator.usageBudget({ runId: run.runId });
    deepStrictEqual(budget.totals, { reported: {}, estimated: { tokens: 500 }, unknownLines: 0 });

    // The run section's read surfaces the origin and the outcome evidence —
    // the display vocabulary the panel renders from, schema-validated.
    const section = await coordinator.runSection({ runId: run.runId });
    strictEqual(section.attempts[0].origin, "manual");
    ok(section.events.some((envelope) => envelope.event.kind === "attempt.outcome"));
  });
});

test("a start-denied attempt grounds the one coordinator retry, exactly once", async () => {
  await withLiveConversation(async ({ coordinator, store, run, attempt }) => {
    // A runtime the port denies before it could start: the known-failure
    // evidence of a start denial.
    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: attempt.attemptId,
      outcome: { kind: "start-denied", code: "runtime_ended" },
    });
    strictEqual(store.getAttempt(attempt.attemptId).state, "terminal");
    const outcome = store.getAttempt(attempt.attemptId).result;
    strictEqual(outcome.kind, "start-denied");
    strictEqual(outcome.classification, "known-failure");

    const { attempt: retry, created } = coordinator.requestCoordinatorRetry({
      runId: run.runId,
      fromAttemptId: attempt.attemptId,
      requestId: "retry-req-1",
      intent: { kind: "clarification-retry" },
    });
    strictEqual(created, true);
    ok(retry.attemptId !== attempt.attemptId);

    // Exactly once: a second coordinator retry on this run is the schema's
    // typed refusal, not a second attempt.
    throws(
      () =>
        coordinator.requestCoordinatorRetry({
          runId: run.runId,
          fromAttemptId: attempt.attemptId,
          requestId: "retry-req-2",
          intent: {},
        }),
      (error) => error.code === "coordinator_retry_spent",
    );
    strictEqual(store.listAttempts(run.runId).length, 2);

    // The retry decision is evidence on the ledger.
    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    const retryEvent = events
      .map((envelope) => envelope.event)
      .find((event) => event.kind === "attempt.coordinator-retried");
    strictEqual(retryEvent.data.basis, "proven-non-dispatch");
  });
});

// --- Recovery, reconciliation and quarantine (spec #221, ticket #236, ADR
// --- 0020): the coordinator's recovery commands — every one durable-first
// --- in the store, then announced to the live streams.

test("recording process death announces the uncertainty to live viewers", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-death");
    coordinator.publish({ runId: run.runId, event: lifecycle("active", attempt.attemptId) });

    const { stream } = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 1,
    });
    const pending = stream.next();

    // The kill is observed with an exit status: the runtime's own death is
    // proven, its descendants' fate is not — nothing at this tier observes
    // them.
    coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 143 });

    const frame = await pending;
    deepStrictEqual(frame.value.event, {
      type: "operational",
      kind: "attempt.process-death",
      data: {
        attemptId: attempt.attemptId,
        runId: run.runId,
        exit: 143,
        proof: { runtimeExit: 143 },
        uncertainty: ["descendant-termination"],
      },
      at: "2026-09-18T00:00:00Z",
    });
    // Uncertainty is not terminal: the stream keeps serving after it.
    const stillOpen = stream.next();
    coordinator.publish({ runId: run.runId, event: conversation(attempt.attemptId) });
    const next = await stillOpen;
    strictEqual(next.value.event.type, "conversation");
    stream.return();

    // The record carries the states and the evidence: proof and uncertainty
    // on the attempt, unknown on the run.
    strictEqual(store.getAttempt(attempt.attemptId).state, "unknown");
    deepStrictEqual(store.getAttempt(attempt.attemptId).result, {
      kind: "termination",
      at: "2026-09-18T00:00:00Z",
      proof: { runtimeExit: 143 },
      uncertainty: ["descendant-termination"],
    });
    strictEqual(
      coordinator.observe({ runId: run.runId, afterCursor: 0 }).snapshot.run.state,
      "unknown",
    );
  });
});

test("reconciliation to a cited terminal classification ends the watched attempt's stream", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-reconcile-stream");
    coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });

    const { stream } = coordinator.streamEvents({
      runId: run.runId,
      attemptId: attempt.attemptId,
      afterCursor: 0,
    });
    // The replay first serves the death's operational event.
    const death = await stream.next();
    strictEqual(death.value.event.kind, "attempt.process-death");

    // Uncertainty is not terminal: reconciling keeps the stream open, and
    // only the resolution to terminal — citing its basis — ends it.
    const pending = stream.next();
    coordinator.beginAttemptReconciliation({ attemptId: attempt.attemptId });
    const whileReconciling = await pending;
    strictEqual(whileReconciling.value.event.kind, "attempt.reconciliation.started");

    const ending = stream.next();
    coordinator.resolveAttemptReconciliation({
      attemptId: attempt.attemptId,
      to: "terminal",
      basis: "exit unobserved but session file shows no provider traffic",
    });
    // The resolution's operational event lands first, then the lifecycle
    // terminal the streams watch — committed in that order, served in it.
    const resolvedOp = await ending;
    strictEqual(resolvedOp.value.event.kind, "attempt.reconciliation.resolved");
    const terminal = await stream.next();
    strictEqual(terminal.value.event.type, "lifecycle");
    strictEqual(terminal.value.event.state, "terminal");
    const drained = await stream.next();
    strictEqual(drained.done, true);

    // The resolution event carries the cited basis.
    const observed = coordinator.observe({ runId: run.runId, afterCursor: 0 });
    const resolution = observed.events
      .map((envelope) => envelope.event)
      .find(
        (event) => event.type === "operational" && event.kind === "attempt.reconciliation.resolved",
      );
    deepStrictEqual(resolution.data, {
      attemptId: attempt.attemptId,
      to: "terminal",
      basis: "exit unobserved but session file shows no provider traffic",
    });
  });
});

test("recovery commands are lease-free, and the discard leaves the record honest", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt } = attemptRun(store, "r-recovery");
    coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    coordinator.beginAttemptReconciliation({ attemptId: attempt.attemptId });
    coordinator.beginReconciliation({ runId: run.runId });
    coordinator.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "quarantined" });
    coordinator.resolveReconciliation({ runId: run.runId, to: "quarantined" });

    // Anything but the exact typed confirmation destroys nothing.
    throws(
      () => coordinator.discardRunEvidence({ runId: run.runId, confirmation: "discard" }),
      (error) => error.code === "discard_unconfirmed",
    );

    coordinator.discardRunEvidence({ runId: run.runId, confirmation: run.runId });
    const after = coordinator.observe({ runId: run.runId, afterCursor: 0 });
    // The evidence is gone and named as gone: an empty ledger, no invented
    // gap — while the record itself stays inspectable, marked discarded.
    deepStrictEqual(after.events, []);
    strictEqual(after.latestCursor, 0);
    strictEqual(after.snapshot.run.state, "terminal");
    strictEqual(after.snapshot.run.discardedAt, "2026-09-18T00:00:00Z");
    strictEqual(after.snapshot.attempts[0].state, "quarantined");
  });
});

test("adoption goes through the coordinator: a live lease refuses, the read model never lies", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-adopt" });

    const first = coordinator.acquireLease({ runId: run.runId, owner: "controller-a" });
    throws(
      () => coordinator.acquireLease({ runId: run.runId, owner: "controller-b" }),
      (error) => error.code === "lease_held",
    );
    // The read model shows ownership and expiry arithmetic — never a
    // token, never a claim that anyone is alive.
    deepStrictEqual(coordinator.getLease(run.runId), {
      owner: "controller-a",
      generation: 1,
      acquiredAt: "2026-09-18T00:00:00Z",
      expiresAt: "2026-09-18T00:00:30.000Z",
      expired: false,
    });
    ok(first.lease.token.startsWith("lease_"));
  });
});

test("same-numbered issues in different repositories never collide or cross-read", async () => {
  await withCoordinator(async ({ coordinator, store, databasePath }) => {
    const { run, attempt } = attemptRun(store, "r-cross");
    coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 143 });

    // Another repo, same database file, the same issue number.
    const foreignStore = openClarificationStore({
      hostRepo: "other/project",
      databasePath,
      clock: () => "2026-09-18T00:00:00Z",
    });
    const foreign = createClarificationCoordinator({
      store: foreignStore,
      clock: () => "2026-09-18T00:00:00Z",
      tracker: { readContext: async () => ({}) },
      sessions: { start: async () => ({}) },
    });
    const { run: foreignRun } = foreignStore.createRun({ issueId: "GH-42", requestId: "r-cross" });
    ok(foreignRun.runId !== run.runId);

    // The foreign coordinator cannot see, stream, record, reconcile, adopt,
    // or destroy the other repo's record — every path is the same typed
    // invisibility.
    throws(
      () => foreign.observe({ runId: run.runId, afterCursor: 0 }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () =>
        foreign.streamEvents({ runId: run.runId, attemptId: attempt.attemptId, afterCursor: 0 }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => foreign.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 1 }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => foreign.beginReconciliation({ runId: run.runId }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => foreign.acquireLease({ runId: run.runId, owner: "thief" }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => foreign.discardRunEvidence({ runId: run.runId, confirmation: run.runId }),
      (error) => error.code === "run_not_found",
    );

    // And the foreign repo's own run is untouched by all of it.
    strictEqual(
      foreign.observe({ runId: foreignRun.runId, afterCursor: 0 }).snapshot.run.state,
      "active",
    );
    foreignStore.close();
  });
});

// --- Ticket #234: approving publishes the exact visible diff once ----------

import { bodyDigestFor } from "./approval.mjs";
import { publicationBodyFor } from "./draft.mjs";

// The publication tests run against the REAL store on a temp directory —
// the sequencing semantics (the nonce spent before the write, the outcome
// durable before the answer) are the behavior under test. Only the tracker
// read, the tracker write, and the clock are substituted. The coordinator
// performs three tracker reads per approval — the manifest gate, the fresh
// pre-write check, and the read-back — so a script answers them in order;
// an exhausted script repeats its last read.
const publicationRig = ({ script = [], onWrite, failReadBack = false, mutateAfterWrite } = {}) => {
  const writeCalls = [];
  let readCount = 0;
  // A delivered write changes what the tracker serves: reads after it
  // answer with the written body and a moved revision — the read-back's
  // ground truth. A refused or ambiguous write changes nothing.
  let writtenBody;
  // The one clock the store and the coordinator share, driven by the test —
  // expiry is arithmetic, never a sleep.
  let now = "2026-09-18T10:00:00.000Z";
  const clock = () => now;
  const tracker = {
    readContext: async ({ issueNumber }) => {
      const result =
        writtenBody !== undefined
          ? failReadBack
            ? collectedIssue({
                failed: true,
                warnings: ["the tracker read failed"],
                issue: null,
                revision: null,
                issueProvenance: null,
              })
            : collectedIssue({
                issue: {
                  number: 230,
                  title: "Clarification 09",
                  body: mutateAfterWrite ?? writtenBody,
                  state: "OPEN",
                },
                revision: {
                  updatedAt: "2026-09-18T10:00:05.000Z",
                  bodyHash: bodyDigestFor(mutateAfterWrite ?? writtenBody),
                },
              })
          : script.length === 0
            ? collectedIssue()
            : script[Math.min(readCount, script.length - 1)];
      readCount += 1;
      return typeof result === "function" ? result({ issueNumber, read: readCount }) : result;
    },
    updateIssueBody: async (args) => {
      writeCalls.push(args);
      if (onWrite !== undefined) {
        const outcome = await onWrite(args);
        writtenBody = args.body;
        return outcome;
      }
      writtenBody = args.body;
      return { delivered: true };
    },
  };
  let store;
  const open = async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbench-clarification-publish-"));
    store = openClarificationStore({
      hostRepo: "Quick-Release/workbench",
      databasePath: join(directory, "runs.sqlite"),
      clock,
    });
    const coordinator = createClarificationCoordinator({
      store,
      tracker,
      sessions: fakeSessions(),
      clock,
      provider: "openai-codex-oauth",
      dataDestination: "https://api.openai.com",
      hostRepo: "Quick-Release/workbench",
    });
    return { store, coordinator };
  };
  const close = () => store?.close();
  return {
    open,
    close,
    tracker,
    writeCalls,
    tickMs: (ms) => {
      now = new Date(Date.parse(now) + ms).toISOString();
    },
  };
};

// A started run with an active attempt and a saved draft — the state an
// approval rides on. The clock then moves past the start lease's window:
// by approval time the prior controller's lease has expired, and the
// coordinator re-arms a fresh generation, as it does across any real gap.
// Returns the exact body bytes the draft serializes to and their digest,
// so the test presents what the Developer saw.
const startedWithDraft = async (rig, store, { requestId = "req-publish" } = {}) => {
  const { run } = store.createRun({ issueId: "230", requestId });
  const { lease } = store.acquireLease({ runId: run.runId, owner: "coordinator" });
  const { attempt } = store.createAttempt({
    runId: run.runId,
    requestId: `${requestId}-attempt`,
    intent: { kind: "clarification-start" },
    leaseToken: lease.token,
  });
  const draft = {
    version: "clarification-draft/v1",
    profile: "bug",
    behavior: "the brief's expected behavior",
    observation: "",
    reproduction: "",
    boundary: "",
    scope: "the bounded scope",
    exclusions: [],
    acceptance: ["one observable criterion"],
    dependencies: "",
    performanceClaim: "",
    performanceEvidence: "",
    assumptions: [],
    evidence: [],
  };
  store.saveDraft({ attemptId: attempt.attemptId, draft, leaseToken: lease.token });
  rig.tickMs(60_000);
  const body = publicationBodyFor(draft);
  return { run, attempt, lease, draft, body, bodyDigest: bodyDigestFor(body) };
};

const approveArgs = ({ run, attempt, bodyDigest, requestId = "approve-1" }) => ({
  runId: run.runId,
  attemptId: attempt.attemptId,
  requestId,
  revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
  bodyDigest,
});

test("approving publishes the exact visible diff once, proven by read-back", async () => {
  const rig = publicationRig();
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    const result = await coordinator.approvePublication(approveArgs(state));

    strictEqual(result.published, true);
    strictEqual(result.outcome, "published");
    strictEqual(result.attemptState, "terminal");
    strictEqual(result.runState, "terminal");
    strictEqual(result.readBack.matched, true);
    // The write carried exactly the bytes the binding pinned, and the
    // approval came back consumed — single-use, spent by this publication.
    deepStrictEqual(rig.writeCalls, [{ issueNumber: 230, body: publicationBodyFor(state.draft) }]);
    strictEqual(store.getApproval(result.approval.nonce).status, "consumed");
    // The attempt closed with the publication as its durable outcome.
    strictEqual(store.getAttempt(state.attempt.attemptId).result.kind, "published");
    // The ledger holds the whole story, in order.
    const kinds = store
      .readEvents({ runId: state.run.runId, afterCursor: 0 })
      .events.map(({ event }) => event.kind);
    ok(kinds.includes("publication.approved"));
    ok(kinds.includes("publication.succeeded"));
  } finally {
    rig.close();
  }
});

test("approving without a saved draft is a typed refusal — nothing is approved", async () => {
  const rig = publicationRig();
  const { store, coordinator } = await rig.open();
  try {
    const { run } = store.createRun({ issueId: "230", requestId: "req-publish" });
    const { lease } = store.acquireLease({ runId: run.runId, owner: "coordinator" });
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-publish-attempt",
      intent: { kind: "clarification-start" },
      leaseToken: lease.token,
    });
    await rejects(
      () =>
        coordinator.approvePublication(approveArgs({ run, attempt, bodyDigest: "sha-256:def" })),
      (error) => error.code === "no_draft",
    );
    strictEqual(rig.writeCalls.length, 0);
  } finally {
    rig.close();
  }
});

test("the diff the Developer saw is the diff approval binds to", async () => {
  const rig = publicationRig();
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    // The presented digest is the view's — the draft has moved on since.
    await rejects(
      () =>
        coordinator.approvePublication(
          approveArgs({ ...state, bodyDigest: bodyDigestFor("different bytes") }),
        ),
      (error) => error.code === "approval_stale",
    );
    strictEqual(rig.writeCalls.length, 0);
  } finally {
    rig.close();
  }
});

test("an issue that moved past the rendered revision refuses before anything is recorded", async () => {
  const rig = publicationRig({
    script: [
      collectedIssue({
        revision: { updatedAt: "2026-09-18T12:00:00.000Z", bodyHash: "sha-256:moved" },
      }),
    ],
  });
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    await rejects(
      () => coordinator.approvePublication(approveArgs(state)),
      (error) => error.code === "approval_stale",
    );
    strictEqual(rig.writeCalls.length, 0);
    // No approval row exists: the refusal happened before the binding.
    strictEqual(store.latestApproval(state.attempt.attemptId), null);
  } finally {
    rig.close();
  }
});

test("a replayed approval request is answered from the record, never re-written", async () => {
  const rig = publicationRig();
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    await coordinator.approvePublication(approveArgs(state));
    const replay = await coordinator.approvePublication(approveArgs(state));
    // The record answers the replay with the proven outcome — a success
    // answered as a success, its read-back evidence intact.
    strictEqual(replay.replayed, true);
    strictEqual(replay.published, true);
    strictEqual(replay.outcome, "published");
    strictEqual(replay.readBack.matched, true);
    strictEqual(replay.attemptState, "terminal");
    strictEqual(rig.writeCalls.length, 1, "the tracker write happened exactly once");
  } finally {
    rig.close();
  }
});

test("a concurrent edit between binding and write makes the approval stale and blocks", async () => {
  // Gate one sees the rendered revision; the fresh pre-write check sees a
  // concurrent edit that landed in between.
  const rig = publicationRig({
    script: [
      collectedIssue(),
      collectedIssue({
        revision: { updatedAt: "2026-09-18T10:00:45.000Z", bodyHash: "sha-256:theirs" },
      }),
    ],
  });
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    await rejects(
      () => coordinator.approvePublication(approveArgs(state)),
      (error) => error.code === "approval_stale",
    );
    strictEqual(rig.writeCalls.length, 0, "the blocked write never happened");
    strictEqual(store.latestApproval(state.attempt.attemptId).status, "stale");
    const kinds = store
      .readEvents({ runId: state.run.runId, afterCursor: 0 })
      .events.map(({ event }) => event.kind);
    ok(kinds.includes("publication.blocked"));
    strictEqual(store.getAttempt(state.attempt.attemptId).state, "active");
  } finally {
    rig.close();
  }
});

test("a definite tracker refusal closes the attempt terminal with its evidence", async () => {
  const rig = publicationRig({
    onWrite: async () => {
      const error = new Error("the tracker refused the issue-body write (HTTP 422)");
      error.code = "publication-write-refused";
      throw error;
    },
  });
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    const result = await coordinator.approvePublication(approveArgs(state));
    strictEqual(result.published, false);
    strictEqual(result.outcome, "publication-failed");
    strictEqual(result.reason, "write-refused");
    strictEqual(result.attemptState, "terminal");
    strictEqual(result.runState, "active", "the run stays with the Developer, not parked");
    strictEqual(store.getAttempt(state.attempt.attemptId).result.kind, "publication-failed");
    strictEqual(store.getApproval(result.approval.nonce).status, "consumed");
    ok(
      store
        .readEvents({ runId: state.run.runId, afterCursor: 0 })
        .events.some(({ event }) => event.kind === "publication.failed"),
    );
  } finally {
    rig.close();
  }
});

test("an ambiguous write is an Unknown outcome: no retry exists before reconciliation", async () => {
  const rig = publicationRig({
    onWrite: async () => {
      throw new Error("fetch failed");
    },
  });
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    const result = await coordinator.approvePublication(approveArgs(state));
    strictEqual(result.published, false);
    strictEqual(result.outcome, "publication-unknown");
    strictEqual(result.attemptState, "unknown");
    strictEqual(result.runState, "unknown");
    strictEqual(store.getAttempt(state.attempt.attemptId).result.kind, "publication-unknown");

    // The spent nonce's answer is the record: a fresh approval on the
    // unknown attempt refuses — reconciliation comes first, always. (The
    // clock first moves past the prior command's lease, so the refusal is
    // the attempt's state, not the fence's busy.)
    rig.tickMs(60_000);
    await rejects(
      () =>
        coordinator.approvePublication(
          approveArgs({ ...state, requestId: "approve-2-should-refuse" }),
        ),
      (error) => error.code === "attempt_not_active",
    );
    strictEqual(rig.writeCalls.length, 1, "nothing re-entered the tracker");

    // Reconciliation resolves the uncertainty on the record — and even a
    // resolution never revives the spent approval; the next publication is
    // a fresh approval on whatever the reconciliation leaves active.
    store.beginAttemptReconciliation({ attemptId: state.attempt.attemptId });
    const resolved = store.resolveAttemptReconciliation({
      attemptId: state.attempt.attemptId,
      to: "terminal",
      basis: "the tracker serves the approved body; verified by the human",
    });
    strictEqual(resolved.state, "terminal");
  } finally {
    rig.close();
  }
});

test("a read-back that cannot be read parks the attempt awaiting-human", async () => {
  const rig = publicationRig({ failReadBack: true });
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    const result = await coordinator.approvePublication(approveArgs(state));
    strictEqual(result.published, false);
    strictEqual(result.outcome, "publication-failed");
    strictEqual(result.reason, "read-back-unavailable");
    strictEqual(result.attemptState, "awaiting-human");
    strictEqual(result.runState, "awaiting-human");
  } finally {
    rig.close();
  }
});

test("a read-back that shows another body parks the attempt awaiting-human", async () => {
  const rig = publicationRig({ mutateAfterWrite: "a concurrent human edit" });
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    const result = await coordinator.approvePublication(approveArgs(state));
    strictEqual(result.published, false);
    strictEqual(result.outcome, "publication-failed");
    strictEqual(result.reason, "read-back-mismatch");
    strictEqual(result.attemptState, "awaiting-human");
    strictEqual(result.runState, "awaiting-human");
    ok(result.readBack.matched === false);
    const recorded = store.getAttempt(state.attempt.attemptId).result;
    deepStrictEqual(recorded.observedRevision, {
      updatedAt: "2026-09-18T10:00:05.000Z",
      bodyHash: bodyDigestFor("a concurrent human edit"),
    });
  } finally {
    rig.close();
  }
});

test("the draft view exposes the digest of the exact bytes it displayed", async () => {
  const rig = publicationRig();
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    rig.tickMs(-60_000);
    const view = await coordinator.draftView({
      runId: state.run.runId,
      attemptId: state.attempt.attemptId,
    });
    strictEqual(view.publicationBodyDigest, bodyDigestFor(publicationBodyFor(state.draft)));

    // No draft, no digest — the honest null, like the diff.
    const { run } = store.createRun({ issueId: "231", requestId: "req-nodraft" });
    const { lease } = store.acquireLease({ runId: run.runId, owner: "coordinator" });
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-nodraft-attempt",
      intent: { kind: "clarification-start" },
      leaseToken: lease.token,
    });
    const empty = await coordinator.draftView({ runId: run.runId, attemptId: attempt.attemptId });
    strictEqual(empty.publicationBodyDigest, null);
  } finally {
    rig.close();
  }
});

test("a run whose issue id is not an issue number refuses the approval typed", async () => {
  const rig = publicationRig();
  const { store, coordinator } = await rig.open();
  try {
    const { run } = store.createRun({ issueId: "GH-42", requestId: "req-named" });
    const { lease } = store.acquireLease({ runId: run.runId, owner: "coordinator" });
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-named-attempt",
      intent: { kind: "clarification-start" },
      leaseToken: lease.token,
    });
    const draft = {
      version: "clarification-draft/v1",
      profile: "bug",
      behavior: "x",
      observation: "",
      reproduction: "",
      boundary: "",
      scope: "",
      exclusions: [],
      acceptance: [],
      dependencies: "",
      performanceClaim: "",
      performanceEvidence: "",
      assumptions: [],
      evidence: [],
    };
    store.saveDraft({ attemptId: attempt.attemptId, draft, leaseToken: lease.token });
    await rejects(
      () =>
        coordinator.approvePublication({
          runId: run.runId,
          attemptId: attempt.attemptId,
          requestId: "approve-named",
          revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
          bodyDigest: bodyDigestFor(publicationBodyFor(draft)),
        }),
      (error) => error.code === "invalid_request",
    );
    strictEqual(rig.writeCalls.length, 0);
  } finally {
    rig.close();
  }
});

test("a replay answers from the request's own approval, not the attempt's newest", async () => {
  // The first approval goes stale at the pre-write gate; the Developer
  // re-renders and the second approval publishes. Replaying the first must
  // report ITS fate — stale, never the second's success.
  const movedRevision = { updatedAt: "2026-09-18T10:00:45.000Z", bodyHash: "sha-256:theirs" };
  const rig = publicationRig({
    script: [collectedIssue(), collectedIssue({ revision: movedRevision })],
  });
  const { store, coordinator } = await rig.open();
  try {
    const state = await startedWithDraft(rig, store);
    await rejects(
      () => coordinator.approvePublication(approveArgs({ ...state, requestId: "approve-1" })),
      (error) => error.code === "approval_stale",
    );

    // The clock moves past the first command's lease before the Developer
    // re-approves the re-rendered diff — the same gap any real retry has.
    rig.tickMs(60_000);
    const secondArgs = {
      ...approveArgs({ ...state, requestId: "approve-2" }),
      revision: movedRevision,
    };
    const second = await coordinator.approvePublication(secondArgs);
    strictEqual(second.published, true);
    const secondNonce = second.approval.nonce;

    const firstReplay = await coordinator
      .approvePublication({
        ...secondArgs,
        requestId: "approve-1",
      })
      .then(
        () => "answered",
        (error) => error.code,
      );
    strictEqual(firstReplay, "approval_stale");

    const secondReplay = await coordinator.approvePublication(secondArgs);
    strictEqual(secondReplay.published, true);
    strictEqual(secondReplay.approval.nonce, secondNonce, "the replay speaks for its own approval");
    strictEqual(rig.writeCalls.length, 1, "still exactly one tracker write");
  } finally {
    rig.close();
  }
});

// --- The inspection display facts (spec #221, ticket #237): the run
// --- section's read carries every axis the panels render — lease
// --- ownership, the usage budget's honest totals, the escalation records —
// --- as open reads on the durable record, and the runs list serves the
// --- in-flight chips.

test("the run section carries the display facts: lease, usage, escalations", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    const { run, attempt, lease } = attemptRun(store, "r-inspect");
    store.appendUsageLines({
      runId: run.runId,
      lines: [
        { kind: "reported", unit: "tokens", value: 12400 },
        { kind: "unknown", unit: "subscription" },
      ],
      leaseToken: lease.token,
    });
    store.haltRun({
      runId: run.runId,
      record: {
        runId: run.runId,
        attemptId: attempt.attemptId,
        signature: "sig-1",
        repeats: 2,
        classification: "known-failure",
        kind: "provider-failure",
        reason: "quota",
        remainingAuthority: ["manual-retry"],
        decision: "decide whether to start a fresh manual attempt or abandon this run",
        at: "2026-09-18T00:00:00Z",
      },
      leaseToken: lease.token,
    });

    const section = await coordinator.runSection({ runId: run.runId, afterCursor: 0 });
    // Ownership and expiry arithmetic — never the token.
    deepStrictEqual(section.lease, {
      owner: "test-controller",
      generation: 1,
      acquiredAt: "2026-09-18T00:00:00Z",
      expiresAt: "2026-09-18T00:00:30.000Z",
      expired: false,
    });
    // The budget with its honest totals: kinds never convert.
    strictEqual(section.usage.lines.length, 2);
    deepStrictEqual(section.usage.totals, {
      reported: { tokens: 12400 },
      estimated: {},
      unknownLines: 1,
    });
    // The escalation records ride along — the return card's decision text.
    strictEqual(section.escalations.length, 1);
    strictEqual(
      section.escalations[0].decision,
      "decide whether to start a fresh manual attempt or abandon this run",
    );

    // A run with no lease, no usage, no escalations reads as the honest
    // empty facts — never a guessed default.
    const { run: bare } = store.createRun({ issueId: "GH-43", requestId: "r-bare" });
    const bareSection = await coordinator.runSection({ runId: bare.runId, afterCursor: 0 });
    strictEqual(bareSection.lease, null);
    deepStrictEqual(bareSection.usage, {
      runId: bare.runId,
      lines: [],
      totals: { reported: {}, estimated: {}, unknownLines: 0 },
    });
    deepStrictEqual(bareSection.escalations, []);
  });
});

test("the runs list read serves the in-flight chips", async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    store.createRun({ issueId: "GH-42", requestId: "r-list-1" });
    const { run: second } = store.createRun({ issueId: "GH-43", requestId: "r-list-2" });

    const listed = coordinator.runs();
    strictEqual(listed.length, 2);
    // The projection shape: identity and lifecycle words only — no lease
    // tokens, no dispatch intents.
    const secondView = listed.find((run) => run.issueId === "GH-43");
    deepStrictEqual(secondView, {
      runId: second.runId,
      issueId: "GH-43",
      state: "active",
      createdAt: second.createdAt,
      updatedAt: second.updatedAt,
    });
  });
});
