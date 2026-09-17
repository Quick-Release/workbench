import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// The durable clarification store (spec #221, ticket #225, ADR 0020): the
// host-repo-scoped local SQLite metadata that everything else records into.
// One Operational run record per approved work intent; one Execution attempt
// per dispatch, each with a fresh identity; client Run requests deduplicated
// across reconnects. The lifecycle vocabulary and its legal transitions are
// the store's own — an illegal transition is a typed rejection, never a
// silent write.
//
// Durability posture: creating an attempt IS the durable dispatch intent —
// the intent, the request id, and the fresh attempt identity commit
// atomically before the coordinator touches any side effect, and they read
// back across a close and reopen. The database runs WAL with synchronous
// FULL, so a committed intent survives a crash.
//
// Host-repo scoping: the store is opened for exactly one host repo and every
// row carries its own host_repo; all reads and writes filter on it. Another
// repo's records — even in the very same file — are invisible,
// indistinguishable from missing.
//
// The schema is versioned from day one: a file written by a newer store
// fails closed rather than being guessed at. Read-compatible migrations are
// ticket 05's contract; this ticket only stamps and checks the version.

export const SCHEMA_VERSION = "1";

export const LIFECYCLE_STATES = [
  "active",
  "reconciling",
  "awaiting-human",
  "terminal",
  "unknown",
  "quarantined",
];

// The legal lifecycle transitions. Terminal is absorbing — nothing comes
// back from it. Unknown must be reconciled or human-resolved; it never
// silently becomes active again. Quarantined cannot reactivate: ownership
// and cleanup state are uncertain until reconciliation resolves it.
// Reconciling may return to active — inspection can find the run alive.
export const LIFECYCLE_TRANSITIONS = {
  active: ["reconciling", "awaiting-human", "terminal", "unknown"],
  reconciling: ["active", "awaiting-human", "terminal", "unknown", "quarantined"],
  "awaiting-human": ["active", "reconciling", "terminal", "unknown", "quarantined"],
  unknown: ["reconciling", "awaiting-human", "terminal", "quarantined"],
  quarantined: ["terminal", "awaiting-human"],
  terminal: [],
};

const storeError = (code, message) => Object.assign(new Error(message), { code });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  host_repo TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
`;

// Opens the store for one host repo. `clock` is injected so timestamps are
// deterministic under test; production uses wall time.
export const openClarificationStore = ({
  hostRepo,
  databasePath,
  clock = () => new Date().toISOString(),
}) => {
  if (!hostRepo || typeof hostRepo !== "string")
    throw storeError("invalid_store", "the clarification store must be opened for a host repo");

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = FULL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA);

  const versionRow = database
    .prepare("SELECT value FROM store_meta WHERE key = 'schema_version'")
    .get();
  if (versionRow === undefined) {
    database
      .prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?)")
      .run(SCHEMA_VERSION);
  } else if (versionRow.value !== SCHEMA_VERSION) {
    database.close();
    throw storeError(
      "unsupported_schema_version",
      `the clarification store was written by schema version ${versionRow.value}; this build reads ${SCHEMA_VERSION} and refuses to guess`,
    );
  }

  const insertRun = database.prepare(
    "INSERT INTO runs (run_id, host_repo, issue_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertAttempt = database.prepare(
    "INSERT INTO attempts (attempt_id, run_id, host_repo, request_id, dispatch_intent, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const runRow = (row) =>
    row === undefined
      ? null
      : {
          runId: row.run_id,
          hostRepo: row.host_repo,
          issueId: row.issue_id,
          state: row.state,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };

  const attemptRow = (row) =>
    row === undefined
      ? null
      : {
          attemptId: row.attempt_id,
          runId: row.run_id,
          hostRepo: row.host_repo,
          requestId: row.request_id,
          dispatchIntent: JSON.parse(row.dispatch_intent),
          state: row.state,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };

  // Reads and writes always carry the host repo: a run from another repo is
  // invisible here, indistinguishable from one that does not exist.
  const ownRun = (runId) =>
    database.prepare("SELECT * FROM runs WHERE run_id = ? AND host_repo = ?").get(runId, hostRepo);

  const ownAttempt = (attemptId) =>
    database
      .prepare("SELECT * FROM attempts WHERE attempt_id = ? AND host_repo = ?")
      .get(attemptId, hostRepo);

  const applyTransition = ({ current, to, what }) => {
    if (!LIFECYCLE_STATES.includes(to))
      throw storeError("unknown_state", `"${to}" is not a lifecycle state`);
    const legal = LIFECYCLE_TRANSITIONS[current] ?? [];
    if (!legal.includes(to))
      throw storeError(
        "illegal_transition",
        `a ${what} in state "${current}" cannot move to "${to}"`,
      );
  };

  return {
    close() {
      database.close();
    },

    // One Operational run record per approved work intent.
    createRun({ issueId }) {
      if (!issueId || typeof issueId !== "string")
        throw storeError("invalid_request", "a run needs an issue id");
      const now = clock();
      const run = {
        runId: `run_${randomUUID()}`,
        hostRepo,
        issueId,
        state: "active",
        createdAt: now,
        updatedAt: now,
      };
      insertRun.run(run.runId, run.hostRepo, run.issueId, run.state, run.createdAt, run.updatedAt);
      return run;
    },

    getRun(runId) {
      return runRow(ownRun(runId));
    },

    listRuns() {
      return database
        .prepare("SELECT * FROM runs WHERE host_repo = ? ORDER BY created_at DESC, run_id DESC")
        .all(hostRepo)
        .map(runRow);
    },

    updateRunState({ runId, to }) {
      const row = ownRun(runId);
      if (row === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
      applyTransition({ current: row.state, to, what: "run" });
      database
        .prepare("UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ? AND host_repo = ?")
        .run(to, clock(), runId, hostRepo);
      return runRow(ownRun(runId));
    },

    // The durable dispatch intent: the attempt identity, the deduplicated
    // client request id, and the intent commit atomically here — before the
    // coordinator performs any side effect. A repeated request (the same
    // run, the same request id — a reconnect replay) returns the existing
    // attempt with created: false; a genuine retry carries a new request id
    // and gets a fresh attempt identity.
    createAttempt({ runId, requestId, intent: dispatchIntent }) {
      if (requestId === undefined || typeof requestId !== "string" || requestId.trim() === "")
        throw storeError("invalid_request", "an attempt needs a non-empty request id");
      if (
        dispatchIntent === undefined ||
        dispatchIntent === null ||
        typeof dispatchIntent !== "object" ||
        Array.isArray(dispatchIntent)
      )
        throw storeError("invalid_request", "an attempt carries a dispatch intent object");
      const row = ownRun(runId);
      if (row === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
      if (row.state !== "active")
        throw storeError(
          "run_not_active",
          `run "${runId}" is ${row.state} — new attempts start only on an active run`,
        );

      const replayed = database
        .prepare("SELECT * FROM attempts WHERE run_id = ? AND request_id = ? AND host_repo = ?")
        .get(runId, requestId, hostRepo);
      if (replayed !== undefined) return { attempt: attemptRow(replayed), created: false };

      const now = clock();
      const attempt = {
        attemptId: `attempt_${randomUUID()}`,
        runId,
        hostRepo,
        requestId,
        dispatchIntent,
        state: "active",
        createdAt: now,
        updatedAt: now,
      };
      insertAttempt.run(
        attempt.attemptId,
        attempt.runId,
        attempt.hostRepo,
        attempt.requestId,
        JSON.stringify(attempt.dispatchIntent),
        attempt.state,
        attempt.createdAt,
        attempt.updatedAt,
      );
      return { attempt, created: true };
    },

    getAttempt(attemptId) {
      return attemptRow(ownAttempt(attemptId));
    },

    listAttempts(runId) {
      return database
        .prepare(
          "SELECT * FROM attempts WHERE run_id = ? AND host_repo = ? ORDER BY created_at ASC, attempt_id ASC",
        )
        .all(runId, hostRepo)
        .map(attemptRow);
    },

    updateAttemptState({ attemptId, to }) {
      const row = ownAttempt(attemptId);
      if (row === undefined)
        throw storeError(
          "attempt_not_found",
          `no attempt "${attemptId}" is visible to this host repo`,
        );
      applyTransition({ current: row.state, to, what: "attempt" });
      database
        .prepare(
          "UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_id = ? AND host_repo = ?",
        )
        .run(to, clock(), attemptId, hostRepo);
      return attemptRow(ownAttempt(attemptId));
    },
  };
};
