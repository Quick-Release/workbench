import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LIFECYCLE_STATES, EVENT_ENVELOPE_VERSION, openClarificationStore } from "./store.mjs";
import {
  clarificationEventEnvelopeVersion,
  clarificationLifecycleStates,
} from "../../../src/types.ts";

// Contract tests for the durable clarification store (spec #221, ticket #225,
// ADR 0020): real SQLite on temp directories — nothing is mocked below the
// port. The clock is injected so timestamps are deterministic; ids are the
// store's own.

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

const open = ({ databasePath, hostRepo = "example/project", ...options }) =>
  openClarificationStore({
    hostRepo,
    databasePath,
    clock: () => "2026-09-18T00:00:00Z",
    ...options,
  });

const intent = { adapter: "pi-managed/v1", contextDigest: "sha-256:abc123" };

// One run with one active attempt and the live controller lease that
// created it: the standing fixture of the recovery tests. Attempt creation
// is a mutation, so it travels under the lease like every other one.
const seeded = (store, requestId, owner = "controller") => {
  const { run } = store.createRun({ issueId: "GH-42", requestId });
  const { lease } = store.acquireLease({ runId: run.runId, owner });
  const { attempt } = store.createAttempt({
    runId: run.runId,
    requestId: `${requestId}-attempt`,
    intent,
    leaseToken: lease.token,
  });
  return { run, attempt, token: lease.token };
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
    const { lease } = store.acquireLease({ runId: run.runId, owner: "controller" });

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
    // The replay is a read, not a mutation — it needs no token.
    const replay = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });
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
    const { lease } = first.acquireLease({ runId: run.runId, owner: "controller" });
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
      const { run } = store.createRun({ issueId: "GH-42", requestId: `r-${state}` });
      const { lease } = store.acquireLease({ runId: run.runId, owner: "controller" });
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
    const { run: ended } = store.createRun({ issueId: "GH-42", requestId: "r-ended" });
    const endedLease = store.acquireLease({ runId: ended.runId, owner: "controller" }).lease;
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
    const { run: quarantined } = store.createRun({ issueId: "GH-42", requestId: "r-qrt" });
    const quarantinedLease = store.acquireLease({
      runId: quarantined.runId,
      owner: "controller",
    }).lease;
    store.updateRunState({
      runId: quarantined.runId,
      to: "reconciling",
      leaseToken: quarantinedLease.token,
    });
    store.updateRunState({
      runId: quarantined.runId,
      to: "quarantined",
      leaseToken: quarantinedLease.token,
    });
    throws(
      () =>
        store.updateRunState({
          runId: quarantined.runId,
          to: "active",
          leaseToken: quarantinedLease.token,
        }),
      (error) => error.code === "illegal_transition",
    );

    // An unknown target state is its own typed rejection, never a write.
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-unknown-target" });
    const lease = store.acquireLease({ runId: run.runId, owner: "controller" }).lease;
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
    const { run } = own.createRun({ issueId: "GH-42", requestId: "r-scoped" });
    const { lease } = own.acquireLease({ runId: run.runId, owner: "controller" });
    own.createAttempt({ runId: run.runId, requestId: "req-1", intent, leaseToken: lease.token });
    own.close();

    // Another repo pointed at the very same file: the rows are still not
    // theirs — invisible, indistinguishable from missing.
    const foreign = open({ databasePath, hostRepo: "other/project" });
    strictEqual(foreign.getRun(run.runId), null);
    deepStrictEqual(foreign.listRuns(), []);
    deepStrictEqual(foreign.listAttempts(run.runId), []);
    strictEqual(foreign.getAttempt("no-such-attempt"), null);
    throws(
      () => foreign.updateRunState({ runId: run.runId, to: "terminal" }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => foreign.createAttempt({ runId: run.runId, requestId: "req-9", intent }),
      (error) => error.code === "run_not_found",
    );
    foreign.close();

    // The owning repo still sees everything.
    const again = open({ databasePath, hostRepo: "example/project" });
    strictEqual(again.listRuns().length, 1);
    strictEqual(again.listAttempts(run.runId).length, 1);
    again.close();
  });
});

test("attempts cannot start on a run that is not active", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run: awaiting } = store.createRun({ issueId: "GH-42", requestId: "r-awaiting" });
    const awaitingLease = store.acquireLease({ runId: awaiting.runId, owner: "controller" }).lease;
    store.updateRunState({
      runId: awaiting.runId,
      to: "awaiting-human",
      leaseToken: awaitingLease.token,
    });
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

    const { run: done } = store.createRun({ issueId: "GH-42", requestId: "r-done" });
    const doneLease = store.acquireLease({ runId: done.runId, owner: "controller" }).lease;
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
      () => store.createAttempt({ runId: "run_missing", requestId: "req-1", intent }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => store.updateRunState({ runId: "run_missing", to: "terminal" }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => store.updateAttemptState({ attemptId: "attempt_missing", to: "terminal" }),
      (error) => error.code === "attempt_not_found",
    );
    // An empty request id could never be deduplicated, so it is not one.
    const run = store.createRun({ issueId: "GH-42", requestId: "r-validation" });
    throws(
      () => store.createAttempt({ runId: run.runId, requestId: "  ", intent }),
      (error) => error.code === "invalid_request",
    );
    // The dispatch intent is the durable record; creating an attempt without
    // one would be a side effect without an intent.
    throws(
      () => store.createAttempt({ runId: run.runId, requestId: "req-2" }),
      (error) => error.code === "invalid_request",
    );
    store.close();
  });
});

test("the operational event ledger reads back sequenced and durable", async () => {
  await withStore(async ({ databasePath }) => {
    const first = open({ databasePath });
    const { run } = first.createRun({ issueId: "GH-42", requestId: "r-ledger" });
    const { lease } = first.acquireLease({ runId: run.runId, owner: "controller" });
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
      leaseToken: lease.token,
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
    const { lease } = store.acquireLease({ runId: run.runId, owner: "controller" });
    const persisted = store.appendEvents({
      runId: run.runId,
      events: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
      leaseToken: lease.token,
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
    const { lease } = store.acquireLease({ runId: run.runId, owner: "controller" });
    store.appendEvents({ runId: run.runId, events: [{ n: 1 }], leaseToken: lease.token });

    throws(
      () => store.appendEvents({ runId: "run_missing", events: [{ n: 1 }] }),
      (error) => error.code === "run_not_found",
    );
    throws(
      () => store.appendEvents({ runId: run.runId, events: [], leaseToken: lease.token }),
      (error) => error.code === "invalid_request",
    );
    throws(
      () => store.appendEvents({ runId: run.runId, events: ["nope"], leaseToken: lease.token }),
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
    const { DatabaseSync } = await import("node:sqlite");
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
  });
});

// --- Recovery, reconciliation and quarantine (spec #221, ticket #236, ADR
// --- 0020). The clock is a variable in these tests so lease expiry has a
// --- deterministic handle.

test("a version-1 file migrates in place: old rows read back, new columns exist", async () => {
  await withStore(async ({ databasePath }) => {
    // A genuine version-1 file: exactly the tables and columns schema 1
    // wrote, one stamped version row, one run and attempt inside.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        host_repo TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (host_repo, request_id)
      );
      CREATE TABLE attempts (
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
      CREATE TABLE events (
        host_repo TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        seq INTEGER NOT NULL,
        event TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (host_repo, run_id, seq)
      );
      INSERT INTO store_meta VALUES ('schema_version', '1');
      INSERT INTO runs VALUES ('run_old', 'example/project', 'GH-42', 'approve-old', 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
      INSERT INTO attempts VALUES ('attempt_old', 'run_old', 'example/project', 'req-old', '{}', 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
      INSERT INTO events VALUES ('example/project', 'run_old', 1, '{"type":"lifecycle"}', '2026-09-01T00:00:00Z');
    `);
    raw.close();

    // The version-2 store opens the old file, migrates it in place, and the
    // rows version 1 wrote keep reading back — nothing rewritten, nothing
    // guessed.
    const store = open({ databasePath });
    deepStrictEqual(store.getRun("run_old"), {
      runId: "run_old",
      hostRepo: "example/project",
      issueId: "GH-42",
      requestId: "approve-old",
      state: "active",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      discardedAt: null,
    });
    const attempt = store.getAttempt("attempt_old");
    strictEqual(attempt.result, null);

    // The migration added exactly the version-2 delta, and the version stamp
    // moved with it.
    const check = new DatabaseSync(databasePath);
    const columns = (table) =>
      check
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
    deepStrictEqual(columns("leases"), [
      "run_id",
      "host_repo",
      "token",
      "generation",
      "owner",
      "acquired_at",
      "expires_at",
    ]);
    ok(columns("attempts").includes("result"));
    ok(columns("runs").includes("discarded_at"));
    strictEqual(
      check.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get().value,
      "2",
    );
    check.close();

    // The migrated file keeps working: the old run can still hold a lease
    // and its ledger still reads.
    const lease = store.acquireLease({ runId: "run_old", owner: "controller" });
    strictEqual(lease.lease.generation, 1);
    deepStrictEqual(store.readEvents({ runId: "run_old", afterCursor: 0 }).events.length, 1);
    store.close();
  });
});

test("a run's controller lease is acquired, held, and superseded by generation", async () => {
  await withStore(async ({ databasePath }) => {
    let now = "2026-09-18T00:00:00Z";
    const store = open({ databasePath, clock: () => now });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-lease" });

    // A fresh acquisition is generation 1, with an opaque token the read
    // model never shows.
    const first = store.acquireLease({ runId: run.runId, owner: "controller-a" });
    strictEqual(first.lease.generation, 1);
    ok(first.lease.token.startsWith("lease_"));
    deepStrictEqual(store.getLease(run.runId), {
      owner: "controller-a",
      generation: 1,
      acquiredAt: now,
      expiresAt: "2026-09-18T00:00:30.000Z",
      expired: false,
    });

    // While the lease lives, nobody else takes it — the refusal names who
    // holds it and until when, and never claims whether they are alive.
    throws(
      () => store.acquireLease({ runId: run.runId, owner: "controller-b" }),
      (error) => error.code === "lease_held",
    );

    // Renewal moves the window, never the identity or the generation.
    now = "2026-09-18T00:00:10Z";
    const renewed = store.renewLease({ runId: run.runId, token: first.lease.token });
    strictEqual(renewed.lease.token, first.lease.token);
    strictEqual(renewed.lease.generation, 1);
    strictEqual(renewed.lease.expiresAt, "2026-09-18T00:00:40.000Z");

    // After expiry, a new controller adopts through a fresh acquisition:
    // generation 2, a new token, and every earlier token is fenced.
    now = "2026-09-18T00:01:00Z";
    const adopted = store.acquireLease({ runId: run.runId, owner: "controller-b" });
    strictEqual(adopted.lease.generation, 2);
    ok(adopted.lease.token !== first.lease.token);
    throws(
      () => store.renewLease({ runId: run.runId, token: first.lease.token }),
      (error) => error.code === "lease_not_held",
    );
    store.close();
  });
});

test("every mutation travels under the live lease; reads never do", async () => {
  await withStore(async ({ databasePath }) => {
    let now = "2026-09-18T00:00:00Z";
    const store = open({ databasePath, clock: () => now });
    const { run, attempt, token } = seeded(store, "r-fence");

    // Without the token, every mutation that claims an effect is refused —
    // a lifecycle move, a completion or cancellation, a cleanup result, a
    // retry decision, an evidence append.
    throws(
      () => store.updateRunState({ runId: run.runId, to: "awaiting-human" }),
      (error) => error.code === "lease_required",
    );
    throws(
      () => store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal" }),
      (error) => error.code === "lease_required",
    );
    throws(
      () =>
        store.recordAttemptResult({ attemptId: attempt.attemptId, result: { kind: "cleanup" } }),
      (error) => error.code === "lease_required",
    );
    throws(
      () => store.createAttempt({ runId: run.runId, requestId: "req-2", intent }),
      (error) => error.code === "lease_required",
    );
    throws(
      () => store.appendEvents({ runId: run.runId, events: [{ n: 1 }] }),
      (error) => error.code === "lease_required",
    );

    // The replay read is not a mutation: a repeated request id still returns
    // the existing attempt, tokenless, creating nothing.
    const replay = store.createAttempt({
      runId: run.runId,
      requestId: "r-fence-attempt",
      intent,
    });
    strictEqual(replay.created, false);
    strictEqual(replay.attempt.attemptId, attempt.attemptId);

    // Reads are open — a restarting controller inspects before it owns.
    ok(store.getRun(run.runId) !== null);
    ok(store.getAttempt(attempt.attemptId) !== null);
    deepStrictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events, []);

    // With the live lease, the same mutations land.
    store.updateRunState({ runId: run.runId, to: "awaiting-human", leaseToken: token });
    strictEqual(store.getRun(run.runId).state, "awaiting-human");
    store.recordAttemptResult({
      attemptId: attempt.attemptId,
      result: { kind: "cleanup" },
      leaseToken: token,
    });
    deepStrictEqual(store.getAttempt(attempt.attemptId).result, { kind: "cleanup" });
    store.close();
  });
});

test("a stale generation cannot write a late completion, cancellation, cleanup result, or retry decision", async () => {
  await withStore(async ({ databasePath }) => {
    let now = "2026-09-18T00:00:00Z";
    const store = open({ databasePath, clock: () => now });
    const { run, attempt, token: deadToken } = seeded(store, "r-stale", "controller-a");
    const dead = { token: deadToken };

    // The controller dies silently; the lease expires; a new generation
    // adopts. Nothing about the old token is ever valid again.
    now = "2026-09-18T00:01:00Z";
    const fresh = store.acquireLease({ runId: run.runId, owner: "controller-b" }).lease;

    const stale = (call) =>
      throws(call, (error) => {
        ok(
          error.code === "lease_not_held" || error.code === "lease_expired",
          `expected a lease fence, got ${error.code}`,
        );
        return true;
      });
    stale(() =>
      store.updateAttemptState({
        attemptId: attempt.attemptId,
        to: "terminal",
        leaseToken: dead.token,
      }),
    );
    stale(() =>
      store.updateAttemptState({
        attemptId: attempt.attemptId,
        to: "awaiting-human",
        leaseToken: dead.token,
      }),
    );
    stale(() =>
      store.recordAttemptResult({
        attemptId: attempt.attemptId,
        result: { kind: "completion" },
        leaseToken: dead.token,
      }),
    );
    stale(() =>
      store.createAttempt({
        runId: run.runId,
        requestId: "req-late-retry",
        intent,
        leaseToken: dead.token,
      }),
    );
    stale(() =>
      store.appendEvents({ runId: run.runId, events: [{ n: 1 }], leaseToken: dead.token }),
    );

    // The new generation writes, and the record shows no trace of the
    // stale writer's attempts.
    store.updateAttemptState({
      attemptId: attempt.attemptId,
      to: "terminal",
      leaseToken: fresh.token,
    });
    strictEqual(store.getAttempt(attempt.attemptId).state, "terminal");
    strictEqual(store.getAttempt(attempt.attemptId).result, null);
    deepStrictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events, []);
    store.close();
  });
});

test("an expired lease permits reconciliation but not adoption-writes", async () => {
  await withStore(async ({ databasePath }) => {
    let now = "2026-09-18T00:00:00Z";
    const store = open({ databasePath, clock: () => now });
    const { run, attempt, token } = seeded(store, "r-expired", "controller-a");

    // Time passes; the holder is gone; nothing about the run changed.
    now = "2026-09-18T00:01:00Z";
    strictEqual(store.getLease(run.runId).expired, true);

    // Expiry fences the late completion...
    throws(
      () =>
        store.updateAttemptState({
          attemptId: attempt.attemptId,
          to: "terminal",
          leaseToken: token,
        }),
      (error) => error.code === "lease_expired",
    );
    // ...but reconciliation is the store's housekeeping on its own records:
    // it claims no external effect, so it needs no lease at all.
    store.beginAttemptReconciliation({ attemptId: attempt.attemptId });
    store.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "quarantined" });
    strictEqual(store.getAttempt(attempt.attemptId).state, "quarantined");
    store.beginReconciliation({ runId: run.runId });
    store.resolveReconciliation({ runId: run.runId, to: "awaiting-human" });
    strictEqual(store.getRun(run.runId).state, "awaiting-human");
    store.close();
  });
});

test("process death ends the attempt and the run in Unknown, with proof or uncertainty recorded", async () => {
  await withStore(async ({ databasePath }) => {
    let now = "2026-09-18T00:00:00Z";
    const store = open({ databasePath, clock: () => now });
    const { run, attempt } = seeded(store, "r-death");

    // The managed runtime died mid-attempt. The exit status was observed:
    // the runtime's own termination is proof, the fate of its descendant
    // processes is not.
    now = "2026-09-18T00:00:05Z";
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 143 });
    strictEqual(store.getAttempt(attempt.attemptId).state, "unknown");
    strictEqual(store.getRun(run.runId).state, "unknown");
    deepStrictEqual(store.getAttempt(attempt.attemptId).result, {
      kind: "termination",
      at: "2026-09-18T00:00:05Z",
      proof: { runtimeExit: 143 },
      uncertainty: ["descendant-termination"],
    });

    // The ledger carries the two lifecycle moves, so a live viewer sees the
    // uncertainty land instead of a silent stall.
    const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      events.map((envelope) => envelope.event),
      [
        {
          type: "lifecycle",
          scope: "attempt",
          id: attempt.attemptId,
          state: "unknown",
          at: "2026-09-18T00:00:05Z",
        },
        {
          type: "lifecycle",
          scope: "run",
          id: run.runId,
          state: "unknown",
          at: "2026-09-18T00:00:05Z",
        },
      ],
    );
    store.close();

    // Both moves are durable: an independent handle on the same file reads
    // them — no shared memory to lose.
    const again = open({ databasePath, clock: () => now });
    strictEqual(again.getAttempt(attempt.attemptId).state, "unknown");
    strictEqual(again.getRun(run.runId).state, "unknown");

    // An unobserved exit is recorded as uncertainty about the runtime's own
    // death too — the record never upgrades missing evidence into proof.
    const unseen = seeded(again, "r-death-unseen");
    again.recordProcessDeath({
      runId: unseen.run.runId,
      attemptId: unseen.attempt.attemptId,
      exit: null,
    });
    deepStrictEqual(again.getAttempt(unseen.attempt.attemptId).result, {
      kind: "termination",
      at: "2026-09-18T00:00:05Z",
      proof: {},
      uncertainty: ["runtime-exit", "descendant-termination"],
    });
    again.close();
  });
});

test("process death is never silently repeatable, reusable, or retryable", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, attempt, token } = seeded(store, "r-death-fence");
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
          leaseToken: token,
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
    const stranger = seeded(store, "r-death-stranger");
    throws(
      () =>
        store.recordProcessDeath({
          runId: run.runId,
          attemptId: stranger.attempt.attemptId,
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
    const { run, attempt, token } = seeded(store, "r-death-parked");
    store.updateRunState({ runId: run.runId, to: "awaiting-human", leaseToken: token });

    // A provider failure parked the run for the human; then the process
    // died. The recorded state is the uncertainty, not a silent resume.
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    strictEqual(store.getRun(run.runId).state, "unknown");
    strictEqual(store.getAttempt(attempt.attemptId).state, "unknown");
    store.close();
  });
});

test("reconciliation moves through reconciling and resolves the uncertainty it began with", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, attempt, token } = seeded(store, "r-reconcile");
    store.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 143 });

    // Beginning reconciliation is observed in the ledger...
    store.beginAttemptReconciliation({ attemptId: attempt.attemptId });
    store.beginReconciliation({ runId: run.runId });
    strictEqual(store.getAttempt(attempt.attemptId).state, "reconciling");
    strictEqual(store.getRun(run.runId).state, "reconciling");
    const started = store.readEvents({ runId: run.runId, afterCursor: 2 }).events;
    deepStrictEqual(
      started.map((envelope) => envelope.event),
      [
        {
          type: "lifecycle",
          scope: "attempt",
          id: attempt.attemptId,
          state: "reconciling",
          at: "2026-09-18T00:00:00Z",
        },
        {
          type: "lifecycle",
          scope: "run",
          id: run.runId,
          state: "reconciling",
          at: "2026-09-18T00:00:00Z",
        },
      ],
    );

    // Quarantine is a resolution: the record holds, owned by nobody, until
    // a human resolves or discards it.
    store.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "quarantined" });
    strictEqual(store.getAttempt(attempt.attemptId).state, "quarantined");

    // ...and the quarantined attempt cannot be walked back out by a
    // mutation: even the run's rightful controller cannot reuse it —
    // reuse and deletion wait for reconciliation or discard.
    throws(
      () =>
        store.updateAttemptState({ attemptId: attempt.attemptId, to: "active", leaseToken: token }),
      (error) => error.code === "illegal_transition",
    );

    // Concluding the run's outcome as terminal is a classification of the
    // inspected uncertainty, so it must cite the evidence it inspected — a
    // bare terminal conclusion is exactly the false completion this ticket
    // forbids.
    throws(
      () => store.resolveReconciliation({ runId: run.runId, to: "terminal" }),
      (error) => error.code === "basis_required",
    );
    store.resolveReconciliation({
      runId: run.runId,
      to: "terminal",
      basis: "process exit observed; dispatch produced no provider traffic; cleanup verified",
    });
    strictEqual(store.getRun(run.runId).state, "terminal");

    // Terminal is absorbing: the resolved record starts nothing new.
    throws(
      () => store.beginReconciliation({ runId: run.runId }),
      (error) => error.code === "illegal_transition",
    );

    // Resolving what is not being reconciled, and concluding an outcome
    // without the uncertainty being resolved, are both typed rejections.
    throws(
      () => store.resolveReconciliation({ runId: run.runId, to: "active" }),
      (error) => error.code === "illegal_transition",
    );
    const fresh = seeded(store, "r-reconcile-fresh");
    throws(
      () => store.resolveReconciliation({ runId: fresh.run.runId, to: "quarantined" }),
      (error) => error.code === "illegal_transition",
    );
    store.close();
  });
});

test("retained evidence is discarded only through the typed destructive confirmation", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run, attempt, token } = seeded(store, "r-discard");
    store.appendEvents({ runId: run.runId, events: [{ n: 1 }, { n: 2 }], leaseToken: token });
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
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 6);

    // A live record is not a discard target: the run must first be a
    // recovery state (unknown, awaiting-human, quarantined).
    const live = seeded(store, "r-discard-live");
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
