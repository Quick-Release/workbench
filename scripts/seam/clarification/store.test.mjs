import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_LEASE_TTL_MS,
  EVENT_ENVELOPE_VERSION,
  LIFECYCLE_STATES,
  SCHEMA_VERSION,
  openClarificationStore,
} from "./store.mjs";
import {
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

test("reconciliation resolves uncertainty and never concludes an outcome", async () => {
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
    // the lease-free way out — and it cannot declare a terminal outcome. A
    // live lease closes outcomes; reconciliation resolves uncertainty.
    strictEqual(
      store.beginAttemptReconciliation({ attemptId: attempt.attemptId }).state,
      "reconciling",
    );
    throws(
      () => store.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "terminal" }),
      (error) => error.code === "illegal_transition",
    );
    strictEqual(
      store.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "quarantined" }).state,
      "quarantined",
    );

    // The run-level arc: reconcile, refuse the outcome, park for a human.
    store.beginReconciliation({ runId: run.runId });
    throws(
      () => store.resolveReconciliation({ runId: run.runId, to: "terminal" }),
      (error) => error.code === "illegal_transition",
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
    strictEqual(SCHEMA_VERSION, "2");

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
      "2",
    );
    raw.close();

    const again = open({ databasePath });
    strictEqual(again.getRun("run_pilot").state, "reconciling");
    strictEqual(again.readEvents({ runId: "run_pilot", afterCursor: 0 }).events.length, 1);
    again.close();
  });
});
