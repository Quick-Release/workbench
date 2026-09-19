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
