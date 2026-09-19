import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LIFECYCLE_STATES,
  EVENT_ENVELOPE_VERSION,
  ATTEMPT_ORIGINS,
  openClarificationStore,
} from "./store.mjs";
import {
  clarificationAttemptOrigins,
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
  // The attempt origins are the store's vocabulary too (ticket #235): the
  // one coordinator retry is the schema's law, so the mirror must follow.
  deepStrictEqual([...ATTEMPT_ORIGINS], [...clarificationAttemptOrigins]);
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

    const first = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });
    strictEqual(first.created, true);
    strictEqual(first.attempt.state, "active");
    deepStrictEqual(first.attempt.dispatchIntent, intent);

    // The same client submission replayed across a reconnect: deduplicated.
    const replay = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });
    strictEqual(replay.created, false);
    strictEqual(replay.attempt.attemptId, first.attempt.attemptId);

    // A genuine retry is a fresh execution attempt with its own identity.
    const retry = store.createAttempt({ runId: run.runId, requestId: "req-2", intent });
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
    const { attempt } = first.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
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
      for (const to of path) store.updateRunState({ runId: run.runId, to });
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
    store.updateRunState({ runId: ended.runId, to: "terminal" });
    throws(
      () => store.updateRunState({ runId: ended.runId, to: "active" }),
      (error) => error.code === "illegal_transition",
    );
    throws(
      () => store.updateRunState({ runId: ended.runId, to: "reconciling" }),
      (error) => error.code === "illegal_transition",
    );

    // Quarantine cannot reactivate: ownership is uncertain until resolved.
    const { run: quarantined } = store.createRun({ issueId: "GH-42", requestId: "r-qrt" });
    store.updateRunState({ runId: quarantined.runId, to: "reconciling" });
    store.updateRunState({ runId: quarantined.runId, to: "quarantined" });
    throws(
      () => store.updateRunState({ runId: quarantined.runId, to: "active" }),
      (error) => error.code === "illegal_transition",
    );

    // An unknown target state is its own typed rejection, never a write.
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-unknown-target" });
    throws(
      () => store.updateRunState({ runId: run.runId, to: "paused" }),
      (error) => error.code === "unknown_state",
    );

    // The same rules bind attempts.
    const { attempt } = store.createAttempt({
      runId: run.runId,
      requestId: "req-1",
      intent,
    });
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal" });
    throws(
      () => store.updateAttemptState({ attemptId: attempt.attemptId, to: "active" }),
      (error) => error.code === "illegal_transition",
    );
    store.close();
  });
});

test("records are host-repo-scoped: another repo's records are invisible", async () => {
  await withStore(async ({ databasePath }) => {
    const own = open({ databasePath, hostRepo: "example/project" });
    const { run } = own.createRun({ issueId: "GH-42", requestId: "r-scoped" });
    own.createAttempt({ runId: run.runId, requestId: "req-1", intent });
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
    store.updateRunState({ runId: awaiting.runId, to: "awaiting-human" });
    throws(
      () => store.createAttempt({ runId: awaiting.runId, requestId: "req-1", intent }),
      (error) => error.code === "run_not_active",
    );

    const { run: done } = store.createRun({ issueId: "GH-42", requestId: "r-done" });
    store.updateRunState({ runId: done.runId, to: "terminal" });
    throws(
      () => store.createAttempt({ runId: done.runId, requestId: "req-1", intent }),
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

// --- Ticket #235: failure classification, dispatch evidence, usage budget,
// escalation records (ADR 0023). ---

test("a version-1 store file migrates in place and reads back compatibly", async () => {
  await withStore(async ({ databasePath }) => {
    // A file written by the version-1 store: the pre-#235 attempts table,
    // stamped 1, holding one real row.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, host_repo TEXT NOT NULL, issue_id TEXT NOT NULL,
        request_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE (host_repo, request_id)
      );
      CREATE TABLE attempts (
        attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
        host_repo TEXT NOT NULL, request_id TEXT NOT NULL, dispatch_intent TEXT NOT NULL,
        state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (run_id, request_id)
      );
      CREATE TABLE events (
        host_repo TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id),
        seq INTEGER NOT NULL, event TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (host_repo, run_id, seq)
      );
    `);
    raw.prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', '1')").run();
    raw
      .prepare(
        "INSERT INTO runs (run_id, host_repo, issue_id, request_id, state, created_at, updated_at) VALUES ('run_old', 'example/project', 'GH-42', 'approve-1', 'active', '2026-09-18T00:00:00Z', '2026-09-18T00:00:00Z')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO attempts (attempt_id, run_id, host_repo, request_id, dispatch_intent, state, created_at, updated_at) VALUES ('attempt_old', 'run_old', 'example/project', 'req-1', '{}', 'active', '2026-09-18T00:00:00Z', '2026-09-18T00:00:00Z')",
      )
      .run();
    raw.close();

    // The current store opens it, migrates it, and the old row reads back
    // with the new projection fields honestly empty.
    const store = open({ databasePath });
    const attempt = store.getAttempt("attempt_old");
    strictEqual(attempt.attemptId, "attempt_old");
    strictEqual(attempt.origin, "manual");
    // The new projection fields are honestly absent on old rows.
    strictEqual(attempt.outcome, undefined);
    strictEqual(attempt.dispatchedAt, undefined);

    // The migrated file takes new writes.
    const { attempt: fresh } = store.createAttempt({
      runId: "run_old",
      requestId: "req-2",
      intent,
    });
    strictEqual(fresh.origin, "manual");
    store.close();

    // Reopening does not migrate twice.
    const again = open({ databasePath });
    strictEqual(again.getAttempt("attempt_old").attemptId, "attempt_old");
    again.close();
  });
});

const outcomeVerdict = {
  kind: "provider-failure",
  classification: "known-failure",
  nextAction: "await-human",
  reason: "quota",
  at: "2026-09-18T00:00:02Z",
};

test("an outcome transition writes the verdict and the events atomically", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-outcome" });
    const { attempt } = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });

    const outcomeEvent = {
      type: "outcome",
      scope: "attempt",
      id: attempt.attemptId,
      kind: "provider-failure",
      classification: "known-failure",
      nextAction: "await-human",
      reason: "quota",
      at: "2026-09-18T00:00:02Z",
    };
    const lifecycleEvent = {
      type: "lifecycle",
      scope: "attempt",
      id: attempt.attemptId,
      state: "awaiting-human",
      at: "2026-09-18T00:00:02Z",
    };
    const updated = store.updateAttemptState({
      attemptId: attempt.attemptId,
      to: "awaiting-human",
      events: [outcomeEvent, lifecycleEvent],
      verdict: outcomeVerdict,
    });
    strictEqual(updated.state, "awaiting-human");
    deepStrictEqual(updated.outcome, {
      kind: "provider-failure",
      classification: "known-failure",
      nextAction: "await-human",
      reason: "quota",
      at: "2026-09-18T00:00:02Z",
    });

    // The events landed in the same commit as the state move and the
    // verdict — evidence and record cannot disagree.
    const ledger = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      ledger.map((envelope) => envelope.event),
      [outcomeEvent, lifecycleEvent],
    );
    store.close();

    // The verdict and the events are durable.
    const again = open({ databasePath });
    deepStrictEqual(again.getAttempt(attempt.attemptId).outcome, updated.outcome);
    strictEqual(again.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 2);
    again.close();
  });
});

test("an illegal outcome transition writes nothing, not even its events", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-illegal" });
    const { attempt } = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal" });

    throws(
      () =>
        store.updateAttemptState({
          attemptId: attempt.attemptId,
          to: "awaiting-human",
          events: [{ type: "outcome", scope: "attempt", id: attempt.attemptId, at: "t" }],
          verdict: outcomeVerdict,
        }),
      (error) => error.code === "illegal_transition",
    );
    strictEqual(store.readEvents({ runId: run.runId, afterCursor: 0 }).events.length, 0);
    strictEqual(store.getAttempt(attempt.attemptId).outcome, undefined);
    strictEqual(store.getAttempt(attempt.attemptId).state, "terminal");
    store.close();
  });
});

test("a dispatch mark is durable evidence, recorded once, on an active attempt", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-dispatch" });
    const { attempt } = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });

    const marked = store.markAttemptDispatched({
      attemptId: attempt.attemptId,
      at: "2026-09-18T00:00:03Z",
      evidence: { argv: ["pi", "--mode", "rpc"] },
    });
    strictEqual(marked.dispatchedAt, "2026-09-18T00:00:03Z");

    // The dispatch event rides the same commit as the mark.
    const ledger = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      ledger.map((envelope) => envelope.event.type),
      ["dispatch"],
    );
    deepStrictEqual(ledger[0].event, {
      type: "dispatch",
      scope: "attempt",
      id: attempt.attemptId,
      at: "2026-09-18T00:00:03Z",
    });

    // A second mark is contradictory evidence — the first is the record.
    throws(
      () =>
        store.markAttemptDispatched({ attemptId: attempt.attemptId, at: "2026-09-18T00:00:04Z" }),
      (error) => error.code === "dispatch_marked",
    );

    // A mark after the attempt ended would corrupt the retry gate's proof.
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal" });
    const { attempt: other } = store.createAttempt({
      runId: run.runId,
      requestId: "req-2",
      intent,
    });
    store.updateAttemptState({ attemptId: other.attemptId, to: "awaiting-human" });
    throws(
      () => store.markAttemptDispatched({ attemptId: other.attemptId, at: "2026-09-18T00:00:05Z" }),
      (error) => error.code === "dispatch_not_markable",
    );
    store.close();

    // The mark survives a restart.
    const again = open({ databasePath });
    strictEqual(again.getAttempt(attempt.attemptId).dispatchedAt, "2026-09-18T00:00:03Z");
    again.close();
  });
});

test("failure signature counts accumulate durably per run", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-signature" });
    const { attempt } = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });

    strictEqual(
      store.recordFailureSignature({
        runId: run.runId,
        signature: "sig-a",
        attemptId: attempt.attemptId,
      }).count,
      1,
    );
    strictEqual(
      store.recordFailureSignature({
        runId: run.runId,
        signature: "sig-a",
        attemptId: attempt.attemptId,
      }).count,
      2,
    );
    strictEqual(
      store.recordFailureSignature({
        runId: run.runId,
        signature: "sig-b",
        attemptId: attempt.attemptId,
      }).count,
      1,
    );
    store.close();

    const again = open({ databasePath });
    strictEqual(
      again.recordFailureSignature({
        runId: run.runId,
        signature: "sig-a",
        attemptId: attempt.attemptId,
      }).count,
      3,
    );
    throws(
      () =>
        again.recordFailureSignature({
          runId: "run_missing",
          signature: "sig-x",
          attemptId: attempt.attemptId,
        }),
      (error) => error.code === "run_not_found",
    );

    // Another run's attempt must never inflate this run's loop counter.
    const { run: otherRun } = again.createRun({ issueId: "GH-42", requestId: "r-signature-other" });
    const { attempt: foreignAttempt } = again.createAttempt({
      runId: otherRun.runId,
      requestId: "req-1",
      intent,
    });
    throws(
      () =>
        again.recordFailureSignature({
          runId: run.runId,
          signature: "sig-x",
          attemptId: foreignAttempt.attemptId,
        }),
      (error) => error.code === "attempt_not_found",
    );
    again.close();
  });
});

test("halting a run records the escalation, parks the run, and happens once per signature", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-halt" });
    const { attempt } = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });

    const record = {
      attemptId: attempt.attemptId,
      signature: "sig-loop",
      repeats: 2,
      classification: "known-failure",
      kind: "provider-failure",
      reason: "quota",
      remainingAuthority: ["manual-retry"],
      decision: "decide whether to start a fresh manual attempt or abandon this run",
      at: "2026-09-18T00:00:06Z",
    };
    const halt = store.haltRun({ runId: run.runId, record });
    strictEqual(halt.moved, true);
    strictEqual(store.getRun(run.runId).state, "awaiting-human");

    // The escalation event landed in the ledger.
    const ledger = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
    deepStrictEqual(
      ledger.map((envelope) => envelope.event.type),
      ["escalation"],
    );
    deepStrictEqual(ledger[0].event, {
      type: "escalation",
      scope: "run",
      id: run.runId,
      ...record,
    });
    deepStrictEqual(store.listEscalations(run.runId), [record]);

    // The same signature cannot escalate twice.
    throws(
      () => store.haltRun({ runId: run.runId, record }),
      (error) => error.code === "already_halted",
    );

    // A second, different signature still records while the run is already
    // halted — the park is idempotent, the handoff is not lost.
    const second = store.haltRun({
      runId: run.runId,
      record: { ...record, signature: "sig-other" },
    });
    strictEqual(second.moved, false);
    strictEqual(store.listEscalations(run.runId).length, 2);
    store.close();

    // Everything is durable.
    const again = open({ databasePath });
    strictEqual(again.getRun(run.runId).state, "awaiting-human");
    strictEqual(again.listEscalations(run.runId).length, 2);
    again.close();
  });
});

test("usage budget lines are durable, ordered, and host-repo-scoped", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-usage" });
    const { attempt } = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });

    const lines = store.appendUsageLines({
      runId: run.runId,
      lines: [
        {
          kind: "reported",
          unit: "provider",
          value: null,
          detail: { total: 12 },
          attemptId: attempt.attemptId,
        },
        { kind: "estimated", unit: "tokens", value: 500 },
      ],
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
        }),
      (error) => error.code === "invalid_request",
    );
    throws(
      () => store.appendUsageLines({ runId: run.runId, lines: [{ kind: "reported", unit: "  " }] }),
      (error) => error.code === "invalid_request",
    );

    // A line may only attribute itself to an attempt of ITS OWN run —
    // another run's attempt would misattribute the usage.
    const { run: otherRun } = store.createRun({ issueId: "GH-42", requestId: "r-usage-other" });
    const { attempt: foreignAttempt } = store.createAttempt({
      runId: otherRun.runId,
      requestId: "req-1",
      intent,
    });
    throws(
      () =>
        store.appendUsageLines({
          runId: run.runId,
          lines: [{ kind: "reported", unit: "provider", attemptId: foreignAttempt.attemptId }],
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
    throws(
      () =>
        foreign.appendUsageLines({ runId: run.runId, lines: [{ kind: "reported", unit: "x" }] }),
      (error) => error.code === "run_not_found",
    );
    foreign.close();
  });
});

test("the coordinator retry is durably limited to one attempt per run", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    const { run } = store.createRun({ issueId: "GH-42", requestId: "r-retry" });

    const manual = store.createAttempt({ runId: run.runId, requestId: "req-1", intent });
    strictEqual(manual.attempt.origin, "manual");

    const retry = store.createAttempt({
      runId: run.runId,
      requestId: "req-2",
      intent,
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
          origin: "coordinator-retry",
        }),
      (error) => error.code === "coordinator_retry_spent",
    );

    // The Developer's manual attempts are not limited.
    store.createAttempt({ runId: run.runId, requestId: "req-4", intent });
    strictEqual(store.listAttempts(run.runId).length, 3);

    throws(
      () =>
        store.createAttempt({
          runId: run.runId,
          requestId: "req-5",
          intent,
          origin: "sneaky",
        }),
      (error) => error.code === "invalid_request",
    );
    store.close();

    // The spent retry stays spent across a restart.
    const again = open({ databasePath });
    throws(
      () =>
        again.createAttempt({
          runId: run.runId,
          requestId: "req-6",
          intent,
          origin: "coordinator-retry",
        }),
      (error) => error.code === "coordinator_retry_spent",
    );
    again.close();
  });
});
