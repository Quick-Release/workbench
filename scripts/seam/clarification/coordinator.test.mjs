import { deepStrictEqual, match, rejects, strictEqual } from "node:assert";
import test from "node:test";

import { createClarificationCoordinator } from "./coordinator.mjs";

// The clarification coordinator's contract tests (spec #221, ticket #230):
// typed commands in, typed results and rejections out, over fakes injected
// through the module's ports — a fake durable store, a fake tracker read,
// a fake managed-session port, an injected clock. No real SQLite, no real
// tracker, no real runtime. The store's own lease/fencing semantics have
// their contract suite in store.test.mjs; here the coordinator is the seam
// under test: what it orders, what it presents, and what it refuses.

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
      const replayed = runs.find((r) => r.issueId === issueId && r.requestId === requestId);
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
    getEvents: (args) => {
      calls.push(["getEvents", args]);
      return { events: [] };
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
  // the managed session start — happens last.
  const kinds = log.map(([kind]) => kind);
  deepStrictEqual(kinds, [
    "listRuns",
    "createRun",
    "acquireLease",
    "appendEvent",
    "createAttempt",
    "appendEvent",
    "sessions.start",
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
      ["createRun", "acquireLease", "createAttempt", "appendEvent"].includes(kind),
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
  // awaiting-human — Workbench dispatches nothing further on its own.
  const kinds = log.map(([kind]) => kind);
  deepStrictEqual(kinds.slice(-4), [
    "recordAttemptResult",
    "appendEvent",
    "updateAttemptState",
    "updateRunState",
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
      getEvents: (args) => {
        log.push(["getEvents", args]);
        return {
          events: [
            { seq: args.afterCursor + 1, kind: "run.started", data: {}, createdAt: clock() },
          ],
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
  deepStrictEqual(section.events, [{ seq: 3, kind: "run.started", data: {}, createdAt: clock() }]);
  // The read is open: no lease token travels on it — a reconnecting viewer
  // never needs to own the run to catch up.
  const read = log.find(([kind]) => kind === "getEvents")[1];
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
    getEvents: ({ afterCursor }) =>
      afterCursor === 0
        ? { events: [] }
        : { events: [], gap: { afterCursor: 4, firstRetainedCursor: 9 } },
  });
  const section = await coordinator({ store }).runSection({ runId: "run_1", afterCursor: 4 });
  deepStrictEqual(section.gap, { afterCursor: 4, firstRetainedCursor: 9 });
  // No gap when the cursor is healthy — history is never dramatized.
  const healthy = await coordinator({ store }).runSection({ runId: "run_1", afterCursor: 0 });
  strictEqual(healthy.gap, undefined);
});
