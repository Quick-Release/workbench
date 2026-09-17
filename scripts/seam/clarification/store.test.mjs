import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LIFECYCLE_STATES, openClarificationStore } from "./store.mjs";

// Contract tests for the durable clarification store (spec #221, ticket #225,
// ADR 0020): real SQLite on temp directories — nothing is mocked below the
// port. The clock is injected so timestamps are deterministic; ids are the
// store's own.

const withStore = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-clarification-store-"));
  const databasePath = join(directory, "runs.sqlite");
  try {
    return await fn({ databasePath, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const open = ({ databasePath, hostRepo = "example/project" }) =>
  openClarificationStore({
    hostRepo,
    databasePath,
    clock: () => "2026-09-18T00:00:00Z",
  });

const intent = { adapter: "pi-managed/v1", contextDigest: "sha-256:abc123" };

test("a created run is durable and reads back across a close and reopen", async () => {
  await withStore(async ({ databasePath }) => {
    const first = open({ databasePath });
    const run = first.createRun({ issueId: "GH-42" });
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
    const run = store.createRun({ issueId: "GH-42" });

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
    const run = first.createRun({ issueId: "GH-42" });
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
      const run = store.createRun({ issueId: "GH-42" });
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
    const ended = store.createRun({ issueId: "GH-42" });
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
    const quarantined = store.createRun({ issueId: "GH-42" });
    store.updateRunState({ runId: quarantined.runId, to: "reconciling" });
    store.updateRunState({ runId: quarantined.runId, to: "quarantined" });
    throws(
      () => store.updateRunState({ runId: quarantined.runId, to: "active" }),
      (error) => error.code === "illegal_transition",
    );

    // An unknown target state is its own typed rejection, never a write.
    const run = store.createRun({ issueId: "GH-42" });
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
    const run = own.createRun({ issueId: "GH-42" });
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
    const awaiting = store.createRun({ issueId: "GH-42" });
    store.updateRunState({ runId: awaiting.runId, to: "awaiting-human" });
    throws(
      () => store.createAttempt({ runId: awaiting.runId, requestId: "req-1", intent }),
      (error) => error.code === "run_not_active",
    );

    const done = store.createRun({ issueId: "GH-42" });
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
    const run = store.createRun({ issueId: "GH-42" });
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

test("an unsupported schema version fails closed", async () => {
  await withStore(async ({ databasePath }) => {
    const store = open({ databasePath });
    store.createRun({ issueId: "GH-42" });
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
