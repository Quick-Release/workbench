import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ATTEMPT_ORIGINS,
  APPROVAL_STATUSES,
  DEFAULT_LEASE_TTL_MS,
  DISCARDABLE_STATES,
  EVENT_ENVELOPE_VERSION,
  LIFECYCLE_STATES,
  SCHEMA_VERSION,
  openClarificationStore,
} from "./store.mjs";
import {
  clarificationAttemptOrigins,
  clarificationEventEnvelopeVersion,
  clarificationLifecycleStates,
} from "../../../src/types.ts";

// Contract tests for the durable clarification store (spec #221, tickets
// #225 + #226, ADR 0020): real SQLite on temp directories — nothing is
// mocked below the port. Clocks are injected so expiry and timestamps are
// deterministic; ids and lease tokens are the store's own.

test("the seam's mirrored observation vocabulary never drifts from the store's", () => {
  // The store owns the lifecycle states and the ledger envelope version;
  // the browser-facing schema mirrors them for validation. Neither side
  // may move without the other.
  deepStrictEqual([...LIFECYCLE_STATES], [...clarificationLifecycleStates]);
  strictEqual(EVENT_ENVELOPE_VERSION, clarificationEventEnvelopeVersion);
});

const withStore = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-clarification-store-"));
  const databasePath = join(directory, "runs.sqlite");
  try {
    return await fn({ databasePath, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const open = ({ databasePath, hostRepo = "example/project", ...options } = {}) =>
  openClarificationStore({
    hostRepo,
    databasePath,
    clock: () => "2026-09-18T00:00:00Z",
    ...options,
  });

// A store whose clock the test drives: expiry is arithmetic, never a sleep.
const openTimed = ({ databasePath, hostRepo = "example/project", eventLedgerLimit } = {}) => {
  let now = "2026-09-18T00:00:00.000Z";
  const store = openClarificationStore({
    hostRepo,
    databasePath,
    clock: () => now,
    ...(eventLedgerLimit === undefined ? {} : { eventLedgerLimit }),
  });
  return {
    store,
    tick: (ms) => {
      now = new Date(Date.parse(now) + ms).toISOString();
    },
  };
};

const intent = { adapter: "pi-managed/v1", contextDigest: "sha-256:abc123" };

// A run with its controller lease: every mutation below the run's creation
// travels under the lease token.
const leasedRun = (store, requestId, owner = "coordinator") => {
  const { run } = store.createRun({ issueId: "GH-42", requestId });
  const { lease } = store.acquireLease({ runId: run.runId, owner });
  return { run, lease };
};

test("a created run is durable and reads back across a close and reopen", async () => {
  await withStore(async ({ databasePath }) => {
    const first = open({ databasePath });
    const { run } = first.createRun({ issueId: "GH-42", requestId: "approve-1" });
    strictEqual(run.hostRepo, "example/project");
    strictEqual(run.issueId, "GH-42");
    strictEqual(run.state, "active");
    strictEqual(run.createdAt, "2026-09-18T00:00:00Z");
    first.close();

    const second = open({ databasePath });
    const readBack = second.getRun(run.runId);
    deepStrictEqual(readBack, run);
    second.close();
  });
});

test("a retry is a new attempt; a repeated run request never creates a second attempt", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const approved = store.createRun({ issueId: "GH-42", requestId: "approve-1" });
    strictEqual(approved.created, true);

    // The same approval replayed across a reconnect: one Operational record.
    const replayed = store.createRun({ issueId: "GH-42", requestId: "approve-1" });
    strictEqual(replayed.created, false);
    strictEqual(replayed.run.runId, approved.run.runId);

    // A genuinely new approval of the same issue is a new intent, a new run.
    const reapproved = store.createRun({ issueId: "GH-42", requestId: "approve-2" });
    strictEqual(reapproved.created, true);
    ok(reapproved.run.runId !== approved.run.runId);

    const run = approved.run;
    const { lease } = store.acquireLease({ runId: run.runId, owner: "coordinator" });

    const first = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    strictEqual(first.created, true);
    strictEqual(first.attempt.state, "active");
    deepStrictEqual(first.attempt.dispatchIntent, intent);

    // The same client submission replayed across a reconnect: deduplicated.
    const replay = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    strictEqual(replay.created, false);
    strictEqual(replay.attempt.attemptId, first.attempt.attemptId);

    // A genuine retry is a fresh execution attempt with its own identity.
    const retry = store.createAttempt({
      runId: run.runId,
      requestId: "req-2",
      intent,
      leaseToken: lease.token,
    });
    strictEqual(retry.created, true);
    ok(retry.attempt.attemptId !== first.attempt.attemptId);

    strictEqual(store.listAttempts(run.runId).length, 2);
    store.close();
  });
});

test("the dispatch intent is durable before any side effect", async () => {
  await withStore(async ({ databasePath }) => {
    const first = open({ databasePath });
    const { run } = first.createRun({ issueId: "GH-42", requestId: "r-durable" });
    const { lease } = first.acquireLease({ runId: run.runId, owner: "coordinator" });
    const { attempt } = first.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    // The attempt — with its dispatch intent — is already committed. A crash
    // here (the close below) must not lose the intent the coordinator is
    // about to act on.
    first.close();

    const second = open({ databasePath });
    const readBack = second.getAttempt(attempt.attemptId);
    deepStrictEqual(readBack.dispatchIntent, intent);
    strictEqual(readBack.state, "active");
    strictEqual(readBack.runId, run.runId);
    second.close();
  });
});

test("every lifecycle state is representable from active", async () => {
  await withStore(async ({ databasePath }) => {
    strictEqual(LIFECYCLE_STATES.length, 6);
    const store = open({ databasePath });

    const paths = {
      active: [],
      reconciling: ["reconciling"],
      "awaiting-human": ["awaiting-human"],
      terminal: ["terminal"],
      unknown: ["unknown"],
      quarantined: ["reconciling", "quarantined"],
    };
    for (const [state, path] of Object.entries(paths)) {
      const { run, lease } = leasedRun(store, `r-${state}`);
      for (const to of path)
        store.updateRunState({ runId: run.runId, to, leaseToken: lease.token });
      strictEqual(store.getRun(run.runId).state, state, state);
    }
    store.close();
  });
});

test("illegal lifecycle transitions are rejected with a typed error", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });

    // Terminal is absorbing: nothing comes back from it.
    const { run: ended, lease: endedLease } = leasedRun(store, "r-ended");
    store.updateRunState({ runId: ended.runId, to: "terminal", leaseToken: endedLease.token });
    throws(
      () =>
        store.updateRunState({ runId: ended.runId, to: "active", leaseToken: endedLease.token }),
      (error) => error.code === "illegal_transition",
    );
    throws(
      () =>
        store.updateRunState({
          runId: ended.runId,
          to: "reconciling",
          leaseToken: endedLease.token,
        }),
      (error) => error.code === "illegal_transition",
    );

    // Quarantine cannot reactivate: ownership is uncertain until resolved.
    const { run: quarantined, lease: qLease } = leasedRun(store, "r-qrt");
    store.updateRunState({ runId: quarantined.runId, to: "reconciling", leaseToken: qLease.token });
    store.updateRunState({ runId: quarantined.runId, to: "quarantined", leaseToken: qLease.token });
    throws(
      () =>
        store.updateRunState({ runId: quarantined.runId, to: "active", leaseToken: qLease.token }),
      (error) => error.code === "illegal_transition",
    );

    // An unknown target state is its own typed rejection, never a write.
    const { run, lease } = leasedRun(store, "r-unknown-target");
    throws(
      () => store.updateRunState({ runId: run.runId, to: "paused", leaseToken: lease.token }),
      (error) => error.code === "unknown_state",
    );

    // The same rules bind attempts.
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    store.updateAttemptState({
      attemptId: attempt.attemptId,
      to: "terminal",
      leaseToken: lease.token,
    });
    throws(
      () =>
        store.updateAttemptState({
          attemptId: attempt.attemptId,
          to: "active",
          leaseToken: lease.token,
        }),
      (error) => error.code === "illegal_transition",
    );
    store.close();
  });
});

test("records are host-repo-scoped: another repo's records are invisible", async () => {
  await withStore(async ({ databasePath }) => {
    const own = open({ databasePath, hostRepo: "example/project" });
    const { run, lease } = leasedRun(own, "r-scoped");
    own.createAttempt({ runId: run.runId, requestId: "req-1", intent, leaseToken: lease.token });
    own.appendEvent({ runId: run.runId, kind: "run.approved", data: {}, leaseToken: lease.token });
    own.saveSnapshot({ runId: run.runId, snapshot: { cursor: 1 }, leaseToken: lease.token });
    own.close();

    // Another repo pointed at the very same file: the rows are still not
    // theirs — invisible, indistinguishable from missing. That holds for the
    // lease, the ledger, and the snapshot too.
    const foreign = open({ databasePath, hostRepo: "other/project" });
    strictEqual(foreign.getRun(run.runId), null);
    deepStrictEqual(foreign.listRuns(), []);
    deepStrictEqual(foreign.listAttempts(run.runId), []);
    strictEqual(foreign.getAttempt("no-such-attempt"), null);
    strictEqual(foreign.getLease(run.runId), null);
    throws(
      () => foreign.readEvents({ runId: run.runId, afterCursor: 0 }),
      (error) => error.code === "run_not_found",
    );
    strictEqual(foreign.getSnapshot(run.runId), null);
    throws(
      () => foreign.updateRunState({ runId: run.runId, to: "terminal", leaseToken: "lease_x" }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () =>
        foreign.createAttempt({
          runId: run.runId,
          requestId: "req-9",
          intent,
          leaseToken: "lease_x",
        }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => foreign.acquireLease({ runId: run.runId, owner: "foreigner" }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => foreign.appendEvent({ runId: run.runId, kind: "x", data: {}, leaseToken: "lease_x" }),
      (error) => error.code === "run_not_found",
    );
    foreign.close();

    // The owning repo still sees everything.
    const again = open({ databasePath, hostRepo: "example/project" });
    strictEqual(again.listRuns().length, 1);
    strictEqual(again.listAttempts(run.runId).length, 1);
    strictEqual(again.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 1);
    again.close();
  });
});

test("attempts cannot start on a run that is not active", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run: awaiting, lease: awaitingLease } = leasedRun(store, "r-awaiting");
    store.updateRunState({
      runId: awaiting.runId,
      to: "awaiting-human",
      leaseToken: awaitingLease.token,
    });
    // Without the lease the gate answers before the state does.
    throws(
      () => store.createAttempt({ runId: awaiting.runId, requestId: "req-1", intent }),
      (error) => error.code === "lease_required",
    );
    throws(
      () =>
        store.createAttempt({
          runId: awaiting.runId,
          requestId: "req-1",
          intent,
          leaseToken: awaitingLease.token,
        }),
      (error) => error.code === "run_not_active",
    );

    const { run: done, lease: doneLease } = leasedRun(store, "r-done");
    store.updateRunState({ runId: done.runId, to: "terminal", leaseToken: doneLease.token });
    throws(
      () =>
        store.createAttempt({
          runId: done.runId,
          requestId: "req-1",
          intent,
          leaseToken: doneLease.token,
        }),
      (error) => error.code === "run_not_active",
    );
    store.close();
  });
});

test("operations on runs that do not exist are typed rejections", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    throws(
      () =>
        store.createAttempt({ runId: "run_missing", requestId: "req-1", intent, leaseToken: "t" }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => store.updateRunState({ runId: "run_missing", to: "terminal", leaseToken: "t" }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () =>
        store.updateAttemptState({ attemptId: "attempt_missing", to: "terminal", leaseToken: "t" }),
      (error) => error.code === "attempt_not_found",
    );
    throws(
      () => store.appendEvent({ runId: "run_missing", kind: "x", data: {}, leaseToken: "t" }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => store.acquireLease({ runId: "run_missing", owner: "coordinator" }),
      (error) => error.code === "run_not_found",
    );
    // An empty request id could never be deduplicated, so it is not one.
    const { run, lease } = leasedRun(store, "r-validation");
    throws(
      () =>
        store.createAttempt({
          runId: run.runId,
          requestId: "  ",
          intent,
          leaseToken: lease.token,
        }),
      (error) => error.code === "invalid_request",
    );
    // The dispatch intent is the durable record; creating an attempt without
    // one would be a side effect without an intent.
    throws(
      () => store.createAttempt({ runId: run.runId, requestId: "req-2", leaseToken: lease.token }),
      (error) => error.code === "invalid_request",
    );
    store.close();
  });
});

test("the operational event ledger reads back sequenced and durable", async () => {
  await withStore(async ({ databasePath }) => {
    const first = open({ databasePath });
    const { run } = first.createRun({ issueId: "GH-42", requestId: "r-ledger" });
    const lifecycle = {
      type: "lifecycle",
      scope: "attempt",
      id: "attempt_one",
      state: "active",
      at: "2026-09-18T00:00:01Z",
    };
    const conversation = {
      type: "conversation",
      attemptId: "attempt_one",
      session: { cursor: 1, envelope: "pi-managed/v1", event: { type: "hello", protocol: "1" } },
    };
    const persisted = first.appendEvents({
      runId: run.runId,
      events: [lifecycle, conversation],
    });
    // Every append reads back under the store's own versioned envelope with
    // a per-run monotonic cursor.
    strictEqual(persisted.length, 2);
    strictEqual(persisted[0].cursor, 1);
    strictEqual(persisted[0].envelope, "clarification-events/v1");
    deepStrictEqual(persisted[0].event, lifecycle);
    strictEqual(persisted[1].cursor, 2);
    deepStrictEqual(persisted[1].event, conversation);
    first.close();

    // Durability: a committed append reads back across a close and reopen,
    // and an empty ledger reads as empty rather than inventing history.
    const second = open({ databasePath });
    deepStrictEqual(second.readEvents({ runId: run.runId, afterCursor: 0 }).events, persisted);
    deepStrictEqual(second.readEvents({ runId: run.runId, afterCursor: 2 }).events, []);
    const fresh = second.createRun({ issueId: "GH-43", requestId: "r-empty" });
    const empty = second.readEvents({ runId: fresh.run.runId, afterCursor: 0 });
    deepStrictEqual(empty.events, []);
    strictEqual(empty.latestCursor, 0);
    second.close();
  });
});

test("an expired cursor reports the explicit gap, never invented history", async () => {
  await withStore(async ({ databasePath }) => {
    // A small retention bound makes the expiry observable: the ledger keeps
    // the newest three events of this run.
    const store = open({ databasePath, eventLedgerLimit: 3 });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-gap" });
    const persisted = store.appendEvents({
      runId: run.runId,
      events: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
    });
    // The oldest event fell off: the first retained cursor is now 2.
    strictEqual(persisted.length, 4);
    strictEqual(persisted[3].cursor, 4);

    // A viewer that never saw event 1 is past retention: the read says so
    // explicitly instead of letting the viewer believe its delta complete.
    const expired = store.readEvents({ runId: run.runId, afterCursor: 0 });
    deepStrictEqual(expired.gap, { after: 0, firstRetainedCursor: 2 });
    strictEqual(expired.latestCursor, 4);
    strictEqual(expired.events.length, 3);
    deepStrictEqual(
      expired.events.map((envelope) => envelope.event.n),
      [2, 3, 4],
    );

    // A viewer on cursor 1 already saw the dropped event: its delta from
    // the retention edge is complete, so there is no gap to report. A
    // viewer at retention reads only what came after.
    const seenDropped = store.readEvents({ runId: run.runId, afterCursor: 1 });
    strictEqual(seenDropped.gap, undefined);
    deepStrictEqual(
      seenDropped.events.map((envelope) => envelope.event.n),
      [2, 3, 4],
    );
    const atRetention = store.readEvents({ runId: run.runId, afterCursor: 2 });
    strictEqual(atRetention.gap, undefined);
    deepStrictEqual(
      atRetention.events.map((envelope) => envelope.event.n),
      [3, 4],
    );
    store.close();

    // The bound is durable policy, not wishful thinking: the reopened store
    // still reports the gap.
    const again = open({ databasePath, eventLedgerLimit: 3 });
    const readBack = again.readEvents({ runId: run.runId, afterCursor: 0 });
    deepStrictEqual(readBack.gap, { after: 0, firstRetainedCursor: 2 });
    again.close();
  });
});

test("ledger reads and appends outside this host repo are typed rejections", async () => {
  await withStore(async ({ databasePath }) => {
    const own = open({ databasePath, hostRepo: "example/project" });
    const { run } = own.createRun({ issueId: "GH-42", requestId: "r-scope" });
    own.close();

    const foreign = open({ databasePath, hostRepo: "other/project" });
    throws(
      () => foreign.appendEvents({ runId: run.runId, events: [{ n: 1 }] }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => foreign.readEvents({ runId: run.runId, afterCursor: 0 }),
      (error) => error.code === "run_not_found",
    );
    foreign.close();
  });
});

test("ledger requests that cannot be answered honestly are typed rejections", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-valid" });
    store.appendEvents({ runId: run.runId, events: [{ n: 1 }] });

    throws(
      () => store.appendEvents({ runId: "run_missing", events: [{ n: 1 }] }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => store.appendEvents({ runId: run.runId, events: [] }),
      (error) => error.code === "invalid_request",
    );
    throws(
      () => store.appendEvents({ runId: run.runId, events: ["nope"] }),
      (error) => error.code === "invalid_request",
    );
    throws(
      () => store.readEvents({ runId: run.runId, afterCursor: -1 }),
      (error) => error.code === "invalid_request",
    );
    // A cursor ahead of the ledger would promise events nobody observed.
    throws(
      () => store.readEvents({ runId: run.runId, afterCursor: 5 }),
      (error) => error.code === "invalid_cursor",
    );
    throws(
      () => store.readEvents({ runId: "run_missing", afterCursor: 0 }),
      (error) => error.code === "run_not_found",
    );
    store.close();
  });
});

test("an unsupported schema version fails closed", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    store.createRun({ issueId: "GH-42", requestId: "r-version" });
    store.close();

    // A future store wrote this file: this version must not guess.
    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE store_meta SET value = '99' WHERE key = 'schema_version'").run();
    raw.close();

    throws(
      () => open({ databasePath }),
      (error) => {
        match(error.message, /schema version/);
        return error.code === "unsupported_schema_version";
      },
    );

    // The same refusal for stamps this store family never wrote — older
    // than the first version, or garbage — all typed, never raw failures.
    const stamp = (value) => {
      const writer = new DatabaseSync(databasePath);
      writer.prepare("UPDATE store_meta SET value = ? WHERE key = 'schema_version'").run(value);
      writer.close();
    };
    for (const value of ["0", "", "not-a-version"]) {
      stamp(value);
      throws(
        () => open({ databasePath }),
        (error) => error.code === "unsupported_schema_version",
      );
    }
  });
});

test("the controller lease is read back as expiry only — never a liveness claim", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-lease" });
    strictEqual(store.getLease(run.runId), null);

    const { lease } = store.acquireLease({ runId: run.runId, owner: "pi-controller" });
    match(lease.token, /^lease_/);
    strictEqual(lease.generation, 1);
    strictEqual(lease.owner, "pi-controller");
    strictEqual(lease.acquiredAt, "2026-09-18T00:00:00.000Z");
    strictEqual(lease.expiresAt, "2026-09-18T00:00:30.000Z");

    // Ownership and expiry arithmetic — that is all the store knows and all
    // it reports. No alive/dead field: a lease is a claim on the record, not
    // a heartbeat, and the token itself never leaves the acquisition.
    deepStrictEqual(store.getLease(run.runId), {
      owner: "pi-controller",
      generation: 1,
      acquiredAt: "2026-09-18T00:00:00.000Z",
      expiresAt: "2026-09-18T00:00:30.000Z",
      expired: false,
    });

    // Expiry is recorded, not resolved: the row stays, described as expired —
    // never as dead.
    tick(DEFAULT_LEASE_TTL_MS + 1);
    strictEqual(store.getLease(run.runId).expired, true);
    strictEqual(store.getLease(run.runId).owner, "pi-controller");
    store.close();
  });
});

test("a live lease cannot be taken; renewal extends it; an expired one cannot be revived", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-contended" });
    const { lease } = store.acquireLease({ runId: run.runId, owner: "viewer-a" });

    // Another owner is told who holds the lease and until when — the
    // "controls moved" fact, without claiming the holder is alive.
    throws(
      () => store.acquireLease({ runId: run.runId, owner: "viewer-b" }),
      (error) => {
        match(error.message, /viewer-a/);
        match(error.message, /until /);
        return error.code === "lease_held";
      },
    );

    // Renewal keeps the identity and the generation; only the window moves.
    tick(1000);
    const renewed = store.renewLease({ runId: run.runId, token: lease.token, ttlMs: 60_000 });
    strictEqual(renewed.lease.token, lease.token);
    strictEqual(renewed.lease.generation, 1);
    strictEqual(renewed.lease.expiresAt, "2026-09-18T00:01:01.000Z");

    throws(
      () => store.renewLease({ runId: run.runId, token: "lease_imposter", ttlMs: 1000 }),
      (error) => error.code === "lease_not_held",
    );

    tick(120_000);
    throws(
      () => store.renewLease({ runId: run.runId, token: lease.token, ttlMs: 1000 }),
      (error) => error.code === "lease_expired",
    );

    // A new acquisition after expiry starts a new generation — the fence the
    // old token cannot pass.
    const takeover = store.acquireLease({ runId: run.runId, owner: "viewer-b" });
    strictEqual(takeover.lease.generation, 2);
    ok(takeover.lease.token !== lease.token);
    store.close();
  });
});

test("every mutation travels under the live controller lease", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "r-gate");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });

    const mutations = (leaseToken, tag) => [
      () => store.updateRunState({ runId: run.runId, to: "awaiting-human", leaseToken }),
      () => store.updateAttemptState({ attemptId: attempt.attemptId, to: "unknown", leaseToken }),
      () =>
        store.createAttempt({
          runId: run.runId,
          requestId: `req-${tag}`,
          intent,
          leaseToken,
        }),
      () =>
        store.recordAttemptResult({
          attemptId: attempt.attemptId,
          result: { kind: "cleanup" },
          leaseToken,
        }),
      () =>
        store.appendEvent({ runId: run.runId, kind: "provider.dispatch", data: {}, leaseToken }),
      () => store.saveSnapshot({ runId: run.runId, snapshot: { cursor: 0 }, leaseToken }),
    ];

    for (const mutation of mutations(undefined, "no-lease"))
      throws(mutation, (error) => error.code === "lease_required");

    tick(DEFAULT_LEASE_TTL_MS + 1);
    for (const mutation of mutations(lease.token, "expired"))
      throws(mutation, (error) => error.code === "lease_expired");

    const { lease: fresh } = store.acquireLease({ runId: run.runId, owner: "next-controller" });
    for (const mutation of mutations(lease.token, "stale"))
      throws(mutation, (error) => error.code === "lease_not_held");

    // The current generation writes.
    store.appendEvent({
      runId: run.runId,
      kind: "provider.dispatch",
      data: {},
      leaseToken: fresh.token,
    });
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 1);
    store.close();
  });
});

test("a reconnect replay deduplicates even once the lease has expired", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "r-replay");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    tick(DEFAULT_LEASE_TTL_MS + 1);

    // The replay is a read, not a mutation: the existing attempt is the
    // answer, and nothing new is authorized or written.
    const replay = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });
    strictEqual(replay.created, false);
    strictEqual(replay.attempt.attemptId, attempt.attemptId);

    // A fresh request id is a new dispatch decision — and that is fenced.
    throws(
      () => store.createAttempt({ runId: run.runId, requestId: "req-2", intent }),
      (error) => error.code === "lease_required",
    );
    strictEqual(store.listAttempts(run.runId).length, 1);
    store.close();
  });
});

test("lease expiry permits reconciliation but not adoption", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "r-expiry");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    tick(DEFAULT_LEASE_TTL_MS + 1);

    // The adoption writes the fence names, each rejected on the expired
    // lease. Expiry is not authorization: it proves nothing and adopts
    // nothing.
    throws(
      () =>
        store.updateAttemptState({
          attemptId: attempt.attemptId,
          to: "terminal",
          leaseToken: lease.token,
        }),
      (error) => error.code === "lease_expired",
    ); // a late completion — or a late cancellation; both claim terminal
    throws(
      () =>
        store.recordAttemptResult({
          attemptId: attempt.attemptId,
          result: { kind: "cleanup" },
          leaseToken: lease.token,
        }),
      (error) => error.code === "lease_expired",
    );
    throws(
      () =>
        store.createAttempt({
          runId: run.runId,
          requestId: "req-retry",
          intent,
          leaseToken: lease.token,
        }),
      (error) => error.code === "lease_expired",
    ); // a retry decision

    // Reconciliation is permitted: recording uncertainty is Workbench's own
    // housekeeping on its own records.
    strictEqual(store.beginReconciliation({ runId: run.runId }).state, "reconciling");
    strictEqual(
      store.resolveReconciliation({ runId: run.runId, to: "awaiting-human" }).state,
      "awaiting-human",
    );

    // And the reconciliation left its evidence in the ledger, lease-free.
    const { events } = store.readEvents({ runId: run.runId, afterCursor: 0 });
    deepStrictEqual(
      events.map((frame) => frame.event.kind),
      ["run.reconciliation.started", "run.reconciliation.resolved"],
    );
    store.close();
  });
});

test("a stale generation cannot write a late completion, cancellation, cleanup result, or retry decision", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "r-fence", "first-controller");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    tick(DEFAULT_LEASE_TTL_MS + 1);
    store.acquireLease({ runId: run.runId, owner: "second-controller" });

    // The first generation is fenced in full once a newer one exists.
    throws(
      () =>
        store.updateAttemptState({
          attemptId: attempt.attemptId,
          to: "terminal",
          leaseToken: lease.token,
        }),
      (error) => error.code === "lease_not_held",
    );
    throws(
      () =>
        store.recordAttemptResult({
          attemptId: attempt.attemptId,
          result: { kind: "completed", effect: "issue-updated" },
          leaseToken: lease.token,
        }),
      (error) => error.code === "lease_not_held",
    );
    throws(
      () =>
        store.createAttempt({
          runId: run.runId,
          requestId: "req-late",
          intent,
          leaseToken: lease.token,
        }),
      (error) => error.code === "lease_not_held",
    );
    throws(
      () =>
        store.appendEvent({
          runId: run.runId,
          kind: "attempt.completed",
          data: {},
          leaseToken: lease.token,
        }),
      (error) => error.code === "lease_not_held",
    );

    // The record proves none of it happened.
    const readBack = store.getAttempt(attempt.attemptId);
    strictEqual(readBack.state, "active");
    strictEqual(readBack.result, null);
    strictEqual(store.listAttempts(run.runId).length, 1);
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 0);
    store.close();
  });
});

test("reconciliation resolves uncertainty; terminal only with a cited basis", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "r-uncertain");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    store.updateAttemptState({
      attemptId: attempt.attemptId,
      to: "unknown",
      leaseToken: lease.token,
    });
    tick(DEFAULT_LEASE_TTL_MS + 1);

    // The attempt is stuck in unknown with a dead lease: reconciliation is
    // the lease-free way out. Terminal is a classification of inspected
    // uncertainty, so a bare conclusion is refused (ticket #236) — the
    // basis has to travel with it. A live lease closes outcomes with
    // results; reconciliation classifies with evidence.
    strictEqual(
      store.beginAttemptReconciliation({ attemptId: attempt.attemptId }).state,
      "reconciling",
    );
    throws(
      () => store.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "terminal" }),
      (error) => error.code === "basis_required",
    );
    strictEqual(
      store.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "quarantined" }).state,
      "quarantined",
    );

    // The run-level arc: reconcile, refuse the bare conclusion, park for a human.
    store.beginReconciliation({ runId: run.runId });
    throws(
      () => store.resolveReconciliation({ runId: run.runId, to: "terminal" }),
      (error) => error.code === "basis_required",
    );
    strictEqual(
      store.resolveReconciliation({ runId: run.runId, to: "awaiting-human" }).state,
      "awaiting-human",
    );

    // The human retry path: a fresh explicit approval moves the run back to
    // active and the new dispatch takes a fresh, fenced generation.
    const { lease: next } = store.acquireLease({ runId: run.runId, owner: "retry-controller" });
    store.updateRunState({ runId: run.runId, to: "active", leaseToken: next.token });
    const retry = store.createAttempt({
      runId: run.runId,
      requestId: "req-retry",
      intent,
      leaseToken: next.token,
    });
    strictEqual(retry.created, true);
    ok(retry.attempt.attemptId !== attempt.attemptId);
    strictEqual(store.listAttempts(run.runId).length, 2);

    // With the basis cited, an attempt's uncertainty resolves to terminal —
    // and the stream-ending lifecycle event commits in the same
    // transaction, so no viewer is served an end that is not yet durable.
    store.updateAttemptState({
      attemptId: retry.attempt.attemptId,
      to: "unknown",
      leaseToken: next.token,
    });
    store.beginAttemptReconciliation({ attemptId: retry.attempt.attemptId });
    const resolved = store.resolveAttemptReconciliation({
      attemptId: retry.attempt.attemptId,
      to: "terminal",
      basis: "session file shows no provider traffic; cleanup verified",
    });
    strictEqual(resolved.state, "terminal");
    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    const last = events[events.length - 1].event;
    deepStrictEqual(last, {
      type: "lifecycle",
      scope: "attempt",
      id: retry.attempt.attemptId,
      state: "terminal",
      at: "2026-09-18T00:00:30.001Z",
    });
    store.close();
  });
});

test("the event ledger reads back sequenced and is persisted before publication", async () => {
  await withStore(async ({ databasePath }) => {
    const first = openTimed({ databasePath });
    const { run, lease } = leasedRun(first.store, "r-ledger");

    const appended = [];
    for (const [kind, data] of [
      ["run.approved", { requestId: "r-ledger" }],
      ["provider.dispatch", { provider: "codex" }],
      ["provider.usage", { tokens: 12, kind: "provider-reported" }],
      ["attempt.reconciled", { outcome: "unknown" }],
      ["run.awaiting-human", { reason: "quota" }],
    ]) {
      appended.push(
        first.store.appendEvent({ runId: run.runId, kind, data, leaseToken: lease.token }),
      );
    }
    // The append returns the committed envelope: its cursor and payload are
    // what the coordinator may publish, and the commit is already durable.
    deepStrictEqual(
      appended.map((frame) => frame.cursor),
      [1, 2, 3, 4, 5],
    );
    first.store.close();

    // Publication may crash now; the ledger does not.
    const second = openTimed({ databasePath });
    const { events } = second.store.readEvents({ runId: run.runId, afterCursor: 0 });
    deepStrictEqual(
      events.map((frame) => frame.cursor),
      [1, 2, 3, 4, 5],
    );
    strictEqual(events[2].event.kind, "provider.usage");
    deepStrictEqual(events[2].event.data, { tokens: 12, kind: "provider-reported" });
    strictEqual(events[4].event.at, "2026-09-18T00:00:00.000Z");
    second.store.close();
  });
});

test("a reader resumes after its cursor; an expired cursor reports an explicit gap", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath, eventLedgerLimit: 5 });
    const { run, lease } = leasedRun(store, "r-cursor");
    for (let seq = 1; seq <= 7; seq += 1) {
      store.appendEvent({
        runId: run.runId,
        kind: `e${seq}`,
        data: { seq },
        leaseToken: lease.token,
      });
      tick(1);
    }

    // Contiguous suffix after a live cursor: no gap at all.
    const live = store.readEvents({ runId: run.runId, afterCursor: 4 });
    strictEqual(live.gap, undefined);
    deepStrictEqual(
      live.events.map((frame) => frame.cursor),
      [5, 6, 7],
    );

    // The ledger is bounded: cursors 1–2 were trimmed to keep the last five.
    // A cursor that predates the retained suffix gets the gap named — the
    // cursor and the first retained cursor — and exactly the retained
    // events. Nothing is invented to fill the gap.
    const expired = store.readEvents({ runId: run.runId, afterCursor: 1 });
    deepStrictEqual(expired.gap, { after: 1, firstRetainedCursor: 3 });
    deepStrictEqual(
      expired.events.map((frame) => frame.cursor),
      [3, 4, 5, 6, 7],
    );
    strictEqual(expired.events.length, 5);

    deepStrictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).gap, {
      after: 0,
      firstRetainedCursor: 3,
    });

    // An up-to-date reader.
    deepStrictEqual(store.readEvents({ runId: run.runId, afterCursor: 7 }).events, []);
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 7 }).gap, undefined);

    // A cursor pointing past the end claims history the store never wrote;
    // that is refused, not papered over.
    throws(
      () => store.readEvents({ runId: run.runId, afterCursor: 8 }),
      (error) => error.code === "invalid_cursor",
    );
    throws(
      () => store.readEvents({ runId: run.runId, afterCursor: -1 }),
      (error) => error.code === "invalid_request",
    );
    store.close();
  });
});

test("snapshots persist for reconnect and their write is fenced like every mutation", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "r-snapshot");
    strictEqual(store.getSnapshot(run.runId), null);

    const snapshot = { conversation: [{ role: "user", text: "hello" }], cursor: 3 };
    store.saveSnapshot({ runId: run.runId, snapshot, leaseToken: lease.token });
    tick(1000);
    const latest = { conversation: [{ role: "assistant", text: "hi" }], cursor: 4 };
    store.saveSnapshot({ runId: run.runId, snapshot: latest, leaseToken: lease.token });
    // Latest wins; the read is the reconnect baseline plus its stamp.
    deepStrictEqual(store.getSnapshot(run.runId), {
      snapshot: latest,
      savedAt: "2026-09-18T00:00:01.000Z",
    });

    throws(
      () => store.saveSnapshot({ runId: run.runId, snapshot: latest, leaseToken: "lease_stale" }),
      (error) => error.code === "lease_not_held",
    );
    throws(
      () =>
        store.saveSnapshot({
          runId: run.runId,
          snapshot: "not-an-object",
          leaseToken: lease.token,
        }),
      (error) => error.code === "invalid_request",
    );
    store.close();

    const reopened = openTimed({ databasePath });
    deepStrictEqual(reopened.store.getSnapshot(run.runId).snapshot, latest);
    reopened.store.close();
  });
});

test("an attempt result is durable and fenced like every mutation", async () => {
  await withStore(async ({ databasePath }) => {
    const { store } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "r-result");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    strictEqual(store.getAttempt(attempt.attemptId).result, null);

    store.recordAttemptResult({
      attemptId: attempt.attemptId,
      result: { kind: "cleanup", removed: ["workspace"] },
      leaseToken: lease.token,
    });
    deepStrictEqual(store.getAttempt(attempt.attemptId).result, {
      kind: "cleanup",
      removed: ["workspace"],
    });

    throws(
      () =>
        store.recordAttemptResult({
          attemptId: attempt.attemptId,
          result: { kind: "completed" },
          leaseToken: "lease_stale",
        }),
      (error) => error.code === "lease_not_held",
    );
    throws(
      () =>
        store.recordAttemptResult({
          attemptId: attempt.attemptId,
          result: { note: "no kind" },
          leaseToken: lease.token,
        }),
      (error) => error.code === "invalid_request",
    );
    store.close();

    const reopened = openTimed({ databasePath });
    deepStrictEqual(reopened.store.getAttempt(attempt.attemptId).result, {
      kind: "cleanup",
      removed: ["workspace"],
    });
    reopened.store.close();
  });
});

const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  host_repo TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (host_repo, request_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  host_repo TEXT NOT NULL,
  request_id TEXT NOT NULL,
  dispatch_intent TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, request_id)
);
CREATE TABLE IF NOT EXISTS events (
  host_repo TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (host_repo, run_id, seq)
);
`;

test("a version-1 file upgrades in place and everything written before reads back", async () => {
  await withStore(async ({ databasePath }) => {
    strictEqual(SCHEMA_VERSION, "6");

    // A file exactly as the previous schema wrote it — version stamp, one
    // run, one attempt — then abandoned mid-pilot.
    const v1 = new DatabaseSync(databasePath);
    v1.exec(V1_SCHEMA);
    v1.prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', '1')").run();
    v1.prepare(
      "INSERT INTO runs (run_id, host_repo, issue_id, request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "run_pilot",
      "example/project",
      "GH-7",
      "approve-pilot",
      "awaiting-human",
      "2026-08-01T00:00:00Z",
      "2026-08-01T00:05:00Z",
    );
    v1.prepare(
      "INSERT INTO attempts (attempt_id, run_id, host_repo, request_id, dispatch_intent, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "attempt_pilot",
      "run_pilot",
      "example/project",
      "req-pilot",
      JSON.stringify(intent),
      "unknown",
      "2026-08-01T00:01:00Z",
      "2026-08-01T00:02:00Z",
    );
    v1.close();

    // The new store opens it, migrates in place, and every old row is
    // interpretable — fields it never had read as absent, never guessed.
    const store = open({ databasePath });
    const run = store.getRun("run_pilot");
    strictEqual(run.state, "awaiting-human");
    strictEqual(run.createdAt, "2026-08-01T00:00:00Z");
    const attempt = store.getAttempt("attempt_pilot");
    strictEqual(attempt.state, "unknown");
    deepStrictEqual(attempt.dispatchIntent, intent);
    strictEqual(attempt.result, null);

    // The migrated file takes new writes: lease, fenced transition, events.
    const { lease } = store.acquireLease({ runId: "run_pilot", owner: "post-upgrade" });
    store.updateRunState({ runId: "run_pilot", to: "reconciling", leaseToken: lease.token });
    store.appendEvent({
      runId: "run_pilot",
      kind: "store.upgraded",
      data: { from: "1" },
      leaseToken: lease.token,
    });
    store.close();

    // The stamp moved with the data; reopening is idempotent.
    const raw = new DatabaseSync(databasePath);
    strictEqual(
      raw.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get().value,
      "6",
    );
    raw.close();

    const again = open({ databasePath });
    strictEqual(again.getRun("run_pilot").state, "reconciling");
    strictEqual(again.readEvents({ runId: "run_pilot", afterCursor: 0 }).events.length, 1);
    again.close();
  });
});

// --- The Clarification draft (spec #221, ticket #233): the attempt's
// --- proposal, persisted locally as one mutable document per attempt.

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

test("a saved draft is durable and reads back across a close and reopen", async () => {
  await withStore(async ({ databasePath }) => {
    const first = open({ databasePath });
    const { run, lease } = leasedRun(first, "approve-1");
    const { attempt } = first.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    const saved = first.saveDraft({
      attemptId: attempt.attemptId,
      draft: draftDocument(),
      leaseToken: lease.token,
    });
    strictEqual(saved.attemptId, attempt.attemptId);
    strictEqual(saved.runId, run.runId);
    strictEqual(saved.createdAt, "2026-09-18T00:00:00Z");
    first.close();

    const second = open({ databasePath });
    const readBack = second.getDraft(attempt.attemptId);
    strictEqual(readBack.attemptId, attempt.attemptId);
    strictEqual(readBack.runId, run.runId);
    deepStrictEqual(readBack.draft, draftDocument());
    second.close();
  });
});

test("a draft is the attempt's one mutable proposal: latest write wins", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "approve-1");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    const first = store.saveDraft({
      attemptId: attempt.attemptId,
      draft: draftDocument({ behavior: "first correction" }),
      leaseToken: lease.token,
    });
    tick(5_000);
    const second = store.saveDraft({
      attemptId: attempt.attemptId,
      draft: draftDocument({ behavior: "second correction" }),
      leaseToken: lease.token,
    });
    // The document is mutable by design; the stamps say which write is the
    // truth: created stays the first save's, updated moves with the last.
    strictEqual(second.createdAt, first.createdAt);
    strictEqual(second.updatedAt, "2026-09-18T00:00:05.000Z");
    deepStrictEqual(
      store.getDraft(attempt.attemptId).draft,
      draftDocument({ behavior: "second correction" }),
    );
    store.close();
  });
});

test("an attempt with no draft reads as null — invisibility is never invented into content", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "approve-1");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    strictEqual(store.getDraft(attempt.attemptId), null);
    // An attempt from another repo is invisible, indistinguishable from
    // one that has no draft.
    strictEqual(store.getDraft("attempt_missing"), null);
    store.close();
  });
});

test("a draft save is fenced like every mutation that writes", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "approve-1");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    throws(
      () => store.saveDraft({ attemptId: attempt.attemptId, draft: draftDocument() }),
      (error) => error.code === "lease_required",
    );
    throws(
      () =>
        store.saveDraft({
          attemptId: attempt.attemptId,
          draft: draftDocument(),
          leaseToken: "lease_stale",
        }),
      (error) => error.code === "lease_not_held",
    );
    tick(31_000);
    throws(
      () =>
        store.saveDraft({
          attemptId: attempt.attemptId,
          draft: draftDocument(),
          leaseToken: lease.token,
        }),
      (error) => error.code === "lease_expired",
    );
    throws(
      () =>
        store.saveDraft({
          attemptId: "attempt_missing",
          draft: draftDocument(),
          leaseToken: lease.token,
        }),
      (error) => error.code === "attempt_not_found",
    );
    throws(
      () =>
        store.saveDraft({
          attemptId: attempt.attemptId,
          draft: "not an object",
          leaseToken: lease.token,
        }),
      (error) => error.code === "invalid_request",
    );
    store.close();
  });
});

test("a draft is scoped to its host repo, even in the very same file", async () => {
  await withStore(async ({ databasePath }) => {
    const first = open({ databasePath });
    const { run, lease } = leasedRun(first, "approve-1");
    const { attempt } = first.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    first.saveDraft({
      attemptId: attempt.attemptId,
      draft: draftDocument(),
      leaseToken: lease.token,
    });
    first.close();

    const other = open({ databasePath, hostRepo: "other/project" });
    strictEqual(other.getDraft(attempt.attemptId), null);
    throws(
      () =>
        other.saveDraft({
          attemptId: attempt.attemptId,
          draft: draftDocument(),
          leaseToken: "lease_any",
        }),
      (error) => error.code === "attempt_not_found",
    );
    other.close();
  });
});

test("a version-2 file upgrades through to the current schema and gains the drafts table", async () => {
  await withStore(async ({ databasePath }) => {
    // A file exactly as schema version 2 wrote it — the v1 tables plus the
    // lease and snapshot tables and the attempts result column — then
    // abandoned mid-pilot.
    const v2 = new DatabaseSync(databasePath);
    v2.exec(`${V1_SCHEMA}
CREATE TABLE IF NOT EXISTS leases (
  run_id TEXT PRIMARY KEY,
  host_repo TEXT NOT NULL,
  token TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_snapshots (
  run_id TEXT PRIMARY KEY,
  host_repo TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
ALTER TABLE attempts ADD COLUMN result TEXT;`);
    v2.prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', '2')").run();
    v2.prepare(
      "INSERT INTO runs (run_id, host_repo, issue_id, request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "run_pilot",
      "example/project",
      "GH-7",
      "approve-pilot",
      "active",
      "2026-08-01T00:00:00Z",
      "2026-08-01T00:05:00Z",
    );
    v2.prepare(
      "INSERT INTO attempts (attempt_id, run_id, host_repo, request_id, dispatch_intent, state, created_at, updated_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(
      "attempt_pilot",
      "run_pilot",
      "example/project",
      "req-pilot",
      JSON.stringify(intent),
      "active",
      "2026-08-01T00:01:00Z",
      "2026-08-01T00:02:00Z",
    );
    v2.close();

    // The new store opens it, migrates in place, every old row is
    // interpretable — and the drafts table takes its first write.
    const store = open({ databasePath });
    strictEqual(store.getRun("run_pilot").state, "active");
    const { lease } = store.acquireLease({ runId: "run_pilot", owner: "post-upgrade" });
    store.saveDraft({
      attemptId: "attempt_pilot",
      draft: draftDocument({ behavior: "written after the upgrade" }),
      leaseToken: lease.token,
    });
    deepStrictEqual(
      store.getDraft("attempt_pilot").draft,
      draftDocument({ behavior: "written after the upgrade" }),
    );
    store.close();

    const raw = new DatabaseSync(databasePath);
    strictEqual(
      raw.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get().value,
      "6",
    );
    raw.close();
  });
});

// --- Ticket #235: the failure policy's durables (ADR 0023). ---

test("the store's attempt origins never drift from the seam's mirrored words", () => {
  deepStrictEqual([...ATTEMPT_ORIGINS], [...clarificationAttemptOrigins]);
});

const V3_SCHEMA = `${V1_SCHEMA}
ALTER TABLE attempts ADD COLUMN result TEXT;
CREATE TABLE IF NOT EXISTS leases (
  run_id TEXT PRIMARY KEY,
  host_repo TEXT NOT NULL,
  token TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_snapshots (
  run_id TEXT PRIMARY KEY,
  host_repo TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  host_repo TEXT NOT NULL,
  draft TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

test("a version-3 file upgrades through to the current schema and gains the failure policy's durables", async () => {
  await withStore(async ({ databasePath }) => {
    // A file exactly as schema version 3 wrote it — everything through the
    // drafts table, with a real attempt row — then abandoned mid-pilot.
    const v3 = new DatabaseSync(databasePath);
    v3.exec(V3_SCHEMA);
    v3.prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', '3')").run();
    v3.prepare(
      "INSERT INTO runs (run_id, host_repo, issue_id, request_id, state, created_at, updated_at) VALUES ('run_pilot', 'example/project', 'GH-7', 'approve-1', 'active', '2026-09-18T00:00:00Z', '2026-09-18T00:00:00Z')",
    ).run();
    v3.prepare(
      "INSERT INTO attempts (attempt_id, run_id, host_repo, request_id, dispatch_intent, state, created_at, updated_at, result) VALUES ('attempt_pilot', 'run_pilot', 'example/project', 'req-1', '{}', 'active', '2026-09-18T00:00:00Z', '2026-09-18T00:00:00Z', NULL)",
    ).run();
    v3.close();

    const store = open({ databasePath });
    // The old row reads back with the new projection fields honestly empty.
    const pilot = store.getAttempt("attempt_pilot");
    strictEqual(pilot.attemptId, "attempt_pilot");
    strictEqual(pilot.origin, "manual");
    strictEqual(pilot.dispatchedAt, undefined);

    // The migrated file takes new writes.
    const { lease } = store.acquireLease({ runId: "run_pilot", owner: "coordinator" });
    const { attempt } = store.createAttempt({
      runId: "run_pilot",
      requestId: "req-2",
      intent,
      leaseToken: lease.token,
    });
    strictEqual(attempt.origin, "manual");
    store.close();

    const raw = new DatabaseSync(databasePath);
    strictEqual(
      raw.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get().value,
      "6",
    );
    raw.close();
  });
});

test("the coordinator retry is durably limited to one attempt per run", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-retry");
    const token = lease.token;

    const manual = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: token,
    });
    strictEqual(manual.attempt.origin, "manual");

    const retry = store.createAttempt({
      runId: run.runId,
      requestId: "req-2",
      intent,
      leaseToken: token,
      origin: "coordinator-retry",
    });
    strictEqual(retry.attempt.origin, "coordinator-retry");

    // The one coordinator retry is spent: a second is a typed refusal, even
    // under a different request id.
    throws(
      () =>
        store.createAttempt({
          runId: run.runId,
          requestId: "req-3",
          intent,
          leaseToken: token,
          origin: "coordinator-retry",
        }),
      (error) => error.code === "coordinator_retry_spent",
    );

    // The Developer's manual attempts are not limited.
    store.createAttempt({ runId: run.runId, requestId: "req-4", intent, leaseToken: token });
    strictEqual(store.listAttempts(run.runId).length, 3);

    throws(
      () =>
        store.createAttempt({
          runId: run.runId,
          requestId: "req-5",
          intent,
          leaseToken: token,
          origin: "sneaky",
        }),
      (error) => error.code === "invalid_request",
    );
    store.close();

    // The spent retry stays spent across a restart — the lease token is a
    // durable capability on the record, so the reopened store honours it.
    const again = open({ databasePath });
    throws(
      () =>
        again.createAttempt({
          runId: run.runId,
          requestId: "req-6",
          intent,
          leaseToken: token,
          origin: "coordinator-retry",
        }),
      (error) => error.code === "coordinator_retry_spent",
    );
    again.close();
  });
});

const outcomeVerdict = (attemptId) => ({
  attemptId,
  kind: "provider-failure",
  classification: "known-failure",
  nextAction: "await-human",
  reason: "quota",
  outcomeAt: "2026-09-18T00:00:00Z",
});

test("an outcome writes the result, the state move, and its event atomically", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-outcome");
    const token = lease.token;
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: token,
    });

    const updated = store.recordAttemptOutcome({
      attemptId: attempt.attemptId,
      to: "awaiting-human",
      result: outcomeVerdict(attempt.attemptId),
      event: {
        kind: "attempt.outcome",
        data: {
          attemptId: attempt.attemptId,
          kind: "provider-failure",
          classification: "known-failure",
          nextAction: "await-human",
          reason: "quota",
        },
      },
      leaseToken: token,
    });
    strictEqual(updated.state, "awaiting-human");
    deepStrictEqual(updated.result, outcomeVerdict(attempt.attemptId));

    // The event landed in the same commit as the state move and the result.
    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      events.map((envelope) => envelope.event.kind),
      ["attempt.outcome"],
    );
    store.close();

    // Durable across a reopen.
    const again = open({ databasePath });
    deepStrictEqual(again.getAttempt(attempt.attemptId).result, outcomeVerdict(attempt.attemptId));
    strictEqual(again.getAttempt(attempt.attemptId).state, "awaiting-human");
    again.close();
  });
});

test("an illegal outcome transition writes nothing, not even its event", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-illegal");
    const token = lease.token;
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: token,
    });
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal", leaseToken: token });

    throws(
      () =>
        store.recordAttemptOutcome({
          attemptId: attempt.attemptId,
          to: "awaiting-human",
          result: outcomeVerdict(attempt.attemptId),
          event: { kind: "attempt.outcome", data: { attemptId: attempt.attemptId } },
          leaseToken: token,
        }),
      (error) => error.code === "illegal_transition",
    );
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 0);
    strictEqual(store.getAttempt(attempt.attemptId).result, null);
  });
});

test("a dispatch mark is durable evidence, recorded once, on an active attempt", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-dispatch");
    const token = lease.token;
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: token,
    });

    const marked = store.markAttemptDispatched({
      attemptId: attempt.attemptId,
      evidence: { argv: ["pi", "--mode", "rpc"] },
      leaseToken: token,
    });
    strictEqual(marked.dispatchedAt, "2026-09-18T00:00:00Z");

    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      events.map((envelope) => envelope.event.kind),
      ["attempt.dispatched"],
    );

    // A second mark is contradictory evidence — the first is the record.
    throws(
      () => store.markAttemptDispatched({ attemptId: attempt.attemptId, leaseToken: token }),
      (error) => error.code === "dispatch_marked",
    );

    // A mark after the attempt ended would corrupt the retry gate's proof.
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal", leaseToken: token });
    throws(
      () => store.markAttemptDispatched({ attemptId: attempt.attemptId, leaseToken: token }),
      (error) => error.code === "dispatch_not_markable",
    );
    store.close();

    const again = open({ databasePath });
    strictEqual(again.getAttempt(attempt.attemptId).dispatchedAt, "2026-09-18T00:00:00Z");
    again.close();
  });
});

test("failure signature counts accumulate durably per run", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-signature");
    const token = lease.token;
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: token,
    });

    strictEqual(
      store.recordFailureSignature({
        runId: run.runId,
        signature: "sig-a",
        attemptId: attempt.attemptId,
        leaseToken: token,
      }).count,
      1,
    );
    strictEqual(
      store.recordFailureSignature({
        runId: run.runId,
        signature: "sig-a",
        attemptId: attempt.attemptId,
        leaseToken: token,
      }).count,
      2,
    );
    strictEqual(
      store.recordFailureSignature({
        runId: run.runId,
        signature: "sig-b",
        attemptId: attempt.attemptId,
        leaseToken: token,
      }).count,
      1,
    );

    // Another run's attempt must never inflate this run's loop counter.
    const { run: otherRun, lease: otherLease } = leasedRun(store, "r-signature-other");
    const { attempt: foreignAttempt } = store.createAttempt({
      runId: otherRun.runId,
      requestId: "req-1",
      intent,
      leaseToken: otherLease.token,
    });
    throws(
      () =>
        store.recordFailureSignature({
          runId: run.runId,
          signature: "sig-x",
          attemptId: foreignAttempt.attemptId,
          leaseToken: token,
        }),
      (error) => error.code === "attempt_not_found",
    );
    store.close();

    const again = open({ databasePath });
    strictEqual(
      again.recordFailureSignature({
        runId: run.runId,
        signature: "sig-a",
        attemptId: attempt.attemptId,
        leaseToken: token,
      }).count,
      3,
    );
    again.close();
  });
});

test("halting a run records the escalation, parks the run, and happens once per signature", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-halt");
    const token = lease.token;
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: token,
    });

    const record = {
      runId: run.runId,
      attemptId: attempt.attemptId,
      signature: "sig-loop",
      repeats: 2,
      classification: "known-failure",
      kind: "provider-failure",
      reason: "quota",
      remainingAuthority: ["manual-retry"],
      decision: "decide whether to start a fresh manual attempt or abandon this run",
      at: "2026-09-18T00:00:00Z",
    };
    const halt = store.haltRun({ runId: run.runId, record, leaseToken: token });
    strictEqual(halt.moved, true);
    strictEqual(store.getRun(run.runId).state, "awaiting-human");

    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      events.map((envelope) => envelope.event.kind),
      ["run.halted"],
    );
    strictEqual(events[0].event.data.signature, "sig-loop");
    deepStrictEqual(store.listEscalations(run.runId), [record]);

    // The same signature cannot escalate twice.
    throws(
      () => store.haltRun({ runId: run.runId, record, leaseToken: token }),
      (error) => error.code === "already_halted",
    );

    // A second, different signature still records while the run is already
    // halted — the park is idempotent, the handoff is not lost.
    const second = store.haltRun({
      runId: run.runId,
      record: { ...record, signature: "sig-other" },
      leaseToken: token,
    });
    strictEqual(second.moved, false);
    strictEqual(store.listEscalations(run.runId).length, 2);
    store.close();

    const again = open({ databasePath });
    strictEqual(again.getRun(run.runId).state, "awaiting-human");
    strictEqual(again.listEscalations(run.runId).length, 2);
    again.close();
  });
});

test("usage budget lines are durable, ordered, and host-repo-scoped", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-usage");
    const token = lease.token;
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: token,
    });

    const lines = store.appendUsageLines({
      runId: run.runId,
      lines: [
        { kind: "reported", unit: "provider", detail: { total: 12 }, attemptId: attempt.attemptId },
        { kind: "estimated", unit: "tokens", value: 500 },
      ],
      leaseToken: token,
    });
    strictEqual(lines.length, 2);
    ok(lines[0].lineId.startsWith("usage_"));
    strictEqual(lines[0].attemptId, attempt.attemptId);
    strictEqual(lines[1].attemptId, undefined);

    throws(
      () =>
        store.appendUsageLines({
          runId: run.runId,
          lines: [{ kind: "reported", unit: "provider", value: "many" }],
          leaseToken: token,
        }),
      (error) => error.code === "invalid_request",
    );

    // A line may only attribute itself to an attempt of ITS OWN run —
    // another run's attempt would misattribute the usage.
    const { run: otherRun, lease: otherLease } = leasedRun(store, "r-usage-other");
    const { attempt: foreignAttempt } = store.createAttempt({
      runId: otherRun.runId,
      requestId: "req-1",
      intent,
      leaseToken: otherLease.token,
    });
    throws(
      () =>
        store.appendUsageLines({
          runId: run.runId,
          lines: [{ kind: "reported", unit: "provider", attemptId: foreignAttempt.attemptId }],
          leaseToken: token,
        }),
      (error) => error.code === "attempt_not_found",
    );
    store.close();

    // The budget spans attempts and restarts: a fresh handle on the same
    // file reads every line back in order.
    const again = open({ databasePath });
    const budget = again.usageBudgetFor(run.runId);
    deepStrictEqual(
      budget.lines.map((line) => [line.kind, line.unit, line.value]),
      [
        ["reported", "provider", null],
        ["estimated", "tokens", 500],
      ],
    );
    deepStrictEqual(budget.lines[0].detail, { total: 12 });
    again.close();

    // Another repo's budget is invisible here.
    const foreign = open({ databasePath, hostRepo: "other/project" });
    throws(
      () => foreign.usageBudgetFor(run.runId),
      (error) => error.code === "run_not_found",
    );
    foreign.close();
  });
});

// --- Recovery, reconciliation and quarantine (spec #221, ticket #236, ADR
// --- 0020): process death ends in Unknown, reconciliation classifies it,
// quarantine holds, and the one destructive path is typed-confirmed.

test("process death ends the attempt and the run in Unknown, with proof or uncertainty recorded", async () => {
  await withStore(async ({ databasePath }) => {
    const { store } = openTimed({ databasePath });
    const { run, lease } = leasedRun(store, "r-death");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });

    // The managed runtime died mid-attempt. The exit status was observed:
    // the runtime's own termination is proof, the fate of its descendant
    // processes is not — nothing at this tier observes them.
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 143 });
    strictEqual(store.getAttempt(attempt.attemptId).state, "unknown");
    strictEqual(store.getRun(run.runId).state, "unknown");
    deepStrictEqual(store.getAttempt(attempt.attemptId).result, {
      kind: "termination",
      at: "2026-09-18T00:00:00.000Z",
      proof: { runtimeExit: 143 },
      uncertainty: ["descendant-termination"],
    });
    // The same evidence travels to viewers as the death's operational
    // event, committed in the same transaction as the moves.
    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    strictEqual(events.length, 1);
    deepStrictEqual(events[0].event, {
      type: "operational",
      kind: "attempt.process-death",
      data: {
        attemptId: attempt.attemptId,
        runId: run.runId,
        exit: 143,
        proof: { runtimeExit: 143 },
        uncertainty: ["descendant-termination"],
      },
      at: "2026-09-18T00:00:00.000Z",
    });

    // An unobserved exit is recorded as uncertainty about the runtime's own
    // death too — the record never upgrades missing evidence into proof.
    const other = leasedRun(store, "r-death-unseen");
    const unseen = store.createAttempt({
      runId: other.run.runId,
      requestId: "req-1",
      intent,
      leaseToken: other.lease.token,
    });
    store.recordProcessDeath({
      runId: other.run.runId,
      attemptId: unseen.attempt.attemptId,
      exit: null,
    });
    deepStrictEqual(store.getAttempt(unseen.attempt.attemptId).result, {
      kind: "termination",
      at: "2026-09-18T00:00:00.000Z",
      proof: {},
      uncertainty: ["runtime-exit", "descendant-termination"],
    });
    store.close();

    // Both moves are durable: a fresh handle on the same file reads them.
    const again = open({ databasePath });
    strictEqual(again.getAttempt(attempt.attemptId).state, "unknown");
    strictEqual(again.getRun(run.runId).state, "unknown");
    again.close();
  });
});

test("process death is never silently repeatable, reusable, or retryable", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-death-fence");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 1 });

    // A second death report writes nothing: the unknown is already the
    // record's answer, and re-recording it would rewrite evidence.
    throws(
      () => store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 1 }),
      (error) => error.code === "illegal_transition",
    );

    // An unknown run starts no new attempt — the silent retry the ticket
    // forbids goes through the run gate, not around it.
    throws(
      () =>
        store.createAttempt({
          runId: run.runId,
          requestId: "req-silent-retry",
          intent,
          leaseToken: lease.token,
        }),
      (error) => error.code === "run_not_active",
    );

    // A death report for an attempt that never existed is typed, not a
    // write somewhere else.
    throws(
      () => store.recordProcessDeath({ runId: run.runId, attemptId: "attempt_missing", exit: 1 }),
      (error) => error.code === "attempt_not_found",
    );

    // An attempt of another run is a mismatch, not a death to record.
    const stranger = leasedRun(store, "r-death-stranger");
    const strangersAttempt = store.createAttempt({
      runId: stranger.run.runId,
      requestId: "req-1",
      intent,
      leaseToken: stranger.lease.token,
    });
    throws(
      () =>
        store.recordProcessDeath({
          runId: run.runId,
          attemptId: strangersAttempt.attempt.attemptId,
          exit: 1,
        }),
      (error) => error.code === "attempt_not_found",
    );
    store.close();
  });
});

test("an awaiting-human run whose process dies lands in Unknown, not back to work", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-death-parked");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    store.updateRunState({ runId: run.runId, to: "awaiting-human", leaseToken: lease.token });

    // A provider failure parked the run for the human; then the process
    // died. The recorded state is the uncertainty, not a silent resume.
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    strictEqual(store.getRun(run.runId).state, "unknown");
    strictEqual(store.getAttempt(attempt.attemptId).state, "unknown");
    store.close();
  });
});

test("a recorded result is write-once: outcome evidence is never rewritten", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-write-once");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });

    // The controller records a requested-termination result while the
    // attempt lives — with the descendant proof it genuinely has, this is
    // the proof half of "descendant-termination attempts record proof or
    // uncertainty".
    store.recordAttemptResult({
      attemptId: attempt.attemptId,
      result: {
        kind: "termination",
        at: "2026-09-18T00:00:00Z",
        proof: { runtimeExit: 0, descendantProcessesExited: true },
        uncertainty: [],
      },
      leaseToken: lease.token,
    });

    // Then the process dies anyway. The unknown still lands — the death is
    // real — but the recorded result survives untouched, and the ledger
    // carries the uncertainty for reconciliation.
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 143 });
    const recorded = store.getAttempt(attempt.attemptId);
    strictEqual(recorded.state, "unknown");
    deepStrictEqual(recorded.result.proof, { runtimeExit: 0, descendantProcessesExited: true });

    // A live lease cannot write a "completion" over the recorded evidence:
    // the false completion this ticket forbids has no path in.
    throws(
      () =>
        store.recordAttemptResult({
          attemptId: attempt.attemptId,
          result: { kind: "completion" },
          leaseToken: lease.token,
        }),
      (error) => error.code === "result_recorded",
    );
    strictEqual(store.getAttempt(attempt.attemptId).result.kind, "termination");
    store.close();
  });
});

test("a quarantined record is stuck for nobody: reconcile or discard both reach it", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-unstuck");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    store.beginAttemptReconciliation({ attemptId: attempt.attemptId });
    store.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "quarantined" });
    store.beginReconciliation({ runId: run.runId });
    store.resolveReconciliation({ runId: run.runId, to: "quarantined" });

    // The human-resolution exit: quarantine yields to awaiting-human under
    // the adopted lease, and from there reconciliation can even find the
    // run resolvable — reuse restored by explicit decisions, never by
    // default.
    store.updateRunState({ runId: run.runId, to: "awaiting-human", leaseToken: lease.token });
    store.beginReconciliation({ runId: run.runId });
    store.resolveReconciliation({ runId: run.runId, to: "active" });
    const revived = store.createAttempt({
      runId: run.runId,
      requestId: "req-after-quarantine",
      intent,
      leaseToken: lease.token,
    });
    strictEqual(revived.created, true);

    // The discard exit is tested below: quarantined is one of its states.
    // Here the point is the record never has no way out.
    store.close();
  });
});

test("retained evidence is discarded only through the typed destructive confirmation", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, lease } = leasedRun(store, "r-discard");
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
      leaseToken: lease.token,
    });
    store.appendEvent({ runId: run.runId, kind: "note", data: { n: 1 }, leaseToken: lease.token });
    store.appendEvent({ runId: run.runId, kind: "note", data: { n: 2 }, leaseToken: lease.token });
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    store.beginReconciliation({ runId: run.runId });
    store.resolveReconciliation({ runId: run.runId, to: "quarantined" });

    // Anything but the exact typed confirmation destroys nothing.
    throws(
      () => store.discardRunEvidence({ runId: run.runId, confirmation: "yes" }),
      (error) => error.code === "discard_unconfirmed",
    );
    throws(
      () => store.discardRunEvidence({ runId: run.runId }),
      (error) => error.code === "discard_unconfirmed",
    );
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 5);

    // A live record is not a discard target: the run must first be a
    // recovery state (unknown, awaiting-human, quarantined).
    const live = leasedRun(store, "r-discard-live");
    throws(
      () => store.discardRunEvidence({ runId: live.run.runId, confirmation: live.run.runId }),
      (error) => error.code === "illegal_transition",
    );

    // The typed confirmation names what it destroys; the discard lands in
    // one commit: the run closes terminal with the discard stamped on it,
    // and the retained evidence is gone — read-only forever was the
    // alternative, never deletion by a generic button.
    store.discardRunEvidence({ runId: run.runId, confirmation: run.runId });
    const discarded = store.getRun(run.runId);
    strictEqual(discarded.state, "terminal");
    strictEqual(discarded.discardedAt, "2026-09-18T00:00:00Z");
    const ledger = store.readEvents({ runId: run.runId, afterCursor: 0 });
    deepStrictEqual(ledger.events, []);
    strictEqual(ledger.latestCursor, 0);

    // The attempt rows survive as records (what happened, with their
    // results) even though the retained event evidence is gone.
    strictEqual(store.getAttempt(attempt.attemptId).state, "unknown");

    // A discard is once: terminal is absorbing.
    throws(
      () => store.discardRunEvidence({ runId: run.runId, confirmation: run.runId }),
      (error) => error.code === "illegal_transition",
    );

    // Another repo's confirmation is not this repo's authority.
    const own = open({ databasePath, hostRepo: "example/project" });
    const foreignRun = own.createRun({ issueId: "GH-42", requestId: "r-discard-fresh" }).run;
    own.close();
    const foreign = open({ databasePath, hostRepo: "other/project" });
    throws(
      () => foreign.discardRunEvidence({ runId: foreignRun.runId, confirmation: foreignRun.runId }),
      (error) => error.code === "run_not_found",
    );
    foreign.close();
    store.close();
  });
});

test("a version-4 file upgrades through to the current schema and gains the discard stamp", async () => {
  await withStore(async ({ databasePath }) => {
    // A current file, then rolled back to exactly what version 4 wrote:
    // the discard column dropped, the stamp moved back — the v4 delta is
    // only the column, so this is a genuine v4 file.
    const seed = open({ databasePath });
    const { run } = seed.createRun({ issueId: "GH-42", requestId: "approve-v4" });
    seed.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec("ALTER TABLE runs DROP COLUMN discarded_at;");
    raw.prepare("UPDATE store_meta SET value = '4' WHERE key = 'schema_version'").run();
    raw.close();

    const store = open({ databasePath });
    // The old row reads back with the new projection field honestly null.
    strictEqual(store.getRun(run.runId).discardedAt, null);
    // The migrated file takes the new write: the run moves to a recovery
    // state first, then the typed discard lands the new column's stamp.
    const { lease } = store.acquireLease({ runId: run.runId, owner: "coordinator" });
    store.updateRunState({ runId: run.runId, to: "awaiting-human", leaseToken: lease.token });
    store.discardRunEvidence({ runId: run.runId, confirmation: run.runId });
    strictEqual(store.getRun(run.runId).state, "terminal");
    strictEqual(store.getRun(run.runId).discardedAt, "2026-09-18T00:00:00Z");
    store.close();

    const check = new DatabaseSync(databasePath);
    strictEqual(
      check.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get().value,
      "6",
    );
    check.close();
  });
});

// --- Ticket #234: the approval binding's durables ---------------------------

import { buildApprovalBinding } from "./approval.mjs";
import { clarificationApprovalStatuses } from "../../../src/types.ts";

test("the approval status vocabulary never drifts from the seam's", () => {
  deepStrictEqual([...APPROVAL_STATUSES], [...clarificationApprovalStatuses]);
});

// An approval binding to record: the full approval of one exact issue-body
// publication, assembled by the binding module and stored verbatim.
const bindingFor = (overrides = {}) =>
  buildApprovalBinding({
    host: "example/project",
    issueNumber: 42,
    issueId: "GH-42",
    revision: { updatedAt: "2026-09-18T00:00:00.000Z", bodyHash: "sha-256:abc" },
    bodyDigest: "sha-256:def",
    provider: "openai-codex-oauth",
    dataDestination: "https://api.openai.com",
    contextDigest: "sha-256:123",
    capabilitySet: ["publishes the approved issue body"],
    ...overrides,
  });

// A run, its active attempt, and the controller lease every mutation
// beneath the run travels under.
const leasedAttempt = (store, requestId = "approve-1") => {
  const { run, lease } = leasedRun(store, requestId);
  const { attempt } = store.createAttempt({
    runId: run.runId,
    requestId: `${requestId}-attempt`,
    intent,
    leaseToken: lease.token,
  });
  return { run, attempt, lease };
};

test("an approval is recorded pending under the lease and reads back whole", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, attempt, lease } = leasedAttempt(store);
    const binding = bindingFor();

    const { approval } = store.recordApproval({
      attemptId: attempt.attemptId,
      binding,
      leaseToken: lease.token,
    });
    ok(approval.nonce.startsWith("approval_"));
    strictEqual(approval.attemptId, attempt.attemptId);
    strictEqual(approval.runId, run.runId);
    strictEqual(approval.status, "pending");
    deepStrictEqual(approval.binding, binding);
    strictEqual(approval.expiresAt, "2026-09-18T00:05:00.000Z");
    strictEqual(approval.consumedAt, undefined);

    const readBack = store.getApproval(approval.nonce);
    deepStrictEqual(readBack, approval);
    deepStrictEqual(store.latestApproval(attempt.attemptId), approval);
    store.close();
  });
});

test("a recorded approval is durable across a close and reopen", async () => {
  await withStore(async ({ databasePath }) => {
    const first = open({ databasePath });
    const { attempt, lease } = leasedAttempt(first);
    const { approval } = first.recordApproval({
      attemptId: attempt.attemptId,
      binding: bindingFor(),
      leaseToken: lease.token,
    });
    first.close();

    const second = open({ databasePath });
    deepStrictEqual(second.getApproval(approval.nonce), approval);
    second.close();
  });
});

test("an approval is single-use: the second consumption is a typed refusal", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { attempt, lease } = leasedAttempt(store);
    const { approval } = store.recordApproval({
      attemptId: attempt.attemptId,
      binding: bindingFor(),
      leaseToken: lease.token,
    });

    const consumed = store.consumeApproval({ nonce: approval.nonce, leaseToken: lease.token });
    strictEqual(consumed.status, "consumed");
    strictEqual(consumed.consumedAt, "2026-09-18T00:00:00Z");

    throws(
      () => store.consumeApproval({ nonce: approval.nonce, leaseToken: lease.token }),
      (error) => error.code === "approval_already_used",
    );
    store.close();
  });
});

test("an expired approval cannot be consumed; a stale one neither", async () => {
  await withStore(async ({ databasePath }) => {
    const { store, tick } = openTimed({ databasePath });
    const { attempt, lease } = leasedAttempt(store);
    const { approval } = store.recordApproval({
      attemptId: attempt.attemptId,
      binding: bindingFor(),
      ttlMs: 1000,
      leaseToken: lease.token,
    });
    tick(2000);
    throws(
      () => store.consumeApproval({ nonce: approval.nonce, leaseToken: lease.token }),
      (error) => error.code === "approval_expired",
    );

    // A fresh approval, deliberately marked stale: the gate refused it, and
    // the store's law makes that refusal permanent.
    const { approval: fresh } = store.recordApproval({
      attemptId: attempt.attemptId,
      binding: bindingFor(),
      leaseToken: lease.token,
    });
    const marked = store.markApprovalStale({ nonce: fresh.nonce, leaseToken: lease.token });
    strictEqual(marked.status, "stale");
    throws(
      () => store.consumeApproval({ nonce: fresh.nonce, leaseToken: lease.token }),
      (error) => error.code === "approval_stale",
    );
    store.close();
  });
});

test("approval mutations travel under the live controller lease", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { attempt, lease } = leasedAttempt(store);
    throws(
      () => store.recordApproval({ attemptId: attempt.attemptId, binding: bindingFor() }),
      (error) => error.code === "lease_required",
    );
    const { approval } = store.recordApproval({
      attemptId: attempt.attemptId,
      binding: bindingFor(),
      leaseToken: lease.token,
    });
    throws(
      () => store.consumeApproval({ nonce: approval.nonce, leaseToken: "lease_forged" }),
      (error) => error.code === "lease_not_held",
    );
    throws(
      () => store.markApprovalStale({ nonce: approval.nonce, leaseToken: "lease_forged" }),
      (error) => error.code === "lease_not_held",
    );
    store.close();
  });
});

test("an approval of another repo's attempt is invisible and unconsumable here", async () => {
  await withStore(async ({ databasePath }) => {
    const home = open({ databasePath, hostRepo: "example/project" });
    const { attempt, lease } = leasedAttempt(home);
    const { approval } = home.recordApproval({
      attemptId: attempt.attemptId,
      binding: bindingFor(),
      leaseToken: lease.token,
    });
    home.close();

    const foreign = open({ databasePath, hostRepo: "other/project" });
    strictEqual(foreign.getApproval(approval.nonce), null);
    throws(
      () => foreign.recordApproval({ attemptId: attempt.attemptId, binding: bindingFor() }),
      (error) => error.code === "attempt_not_found",
    );
    throws(
      () =>
        foreign.consumeApproval({
          nonce: approval.nonce,
          leaseToken: "lease_foreign",
        }),
      (error) => error.code === "approval_not_found",
    );
    foreign.close();
  });
});

test("a version-5 file upgrades to version 6 and gains the approvals table", async () => {
  await withStore(async ({ databasePath }) => {
    // A current file, rolled back to exactly what version 5 wrote: the
    // approvals table dropped, the stamp moved back — the v5 delta is only
    // the table, so this is a genuine v5 file.
    const seed = open({ databasePath });
    const { run } = seed.createRun({ issueId: "GH-42", requestId: "approve-v5" });
    seed.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TABLE approvals;");
    raw.prepare("UPDATE store_meta SET value = '5' WHERE key = 'schema_version'").run();
    raw.close();

    const store = open({ databasePath });
    strictEqual(SCHEMA_VERSION, "6");
    const { lease } = store.acquireLease({ runId: run.runId, owner: "coordinator" });
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "approve-v5-attempt",
      intent,
      leaseToken: lease.token,
    });
    const { approval } = store.recordApproval({
      attemptId: attempt.attemptId,
      binding: bindingFor(),
      leaseToken: lease.token,
    });
    strictEqual(approval.status, "pending");
    strictEqual(store.getRun(run.runId).state, "active");
    store.close();

    const check = new DatabaseSync(databasePath);
    strictEqual(
      check.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get().value,
      "6",
    );
    check.close();
  });
});

// The display layer mirrors the discard gate's law (ticket #237): the
// mirror's list and the store's law are pinned to each other, so one
// cannot move without the other following.
test("the display layer's discardable-states mirror matches the store's law", async () => {
  const inspection = await import("../../../src/lib/clarification-inspection.ts");
  deepStrictEqual(inspection.DISCARDABLE_RUN_STATES, DISCARDABLE_STATES);
});
