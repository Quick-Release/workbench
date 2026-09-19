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
// fails closed rather than being guessed at. Migrations are additive and
// read-compatible: a version-1 file (ticket #225's shape) is altered in
// place on open — ticket #235's failure-policy columns and tables are
// added, old rows read back with the new projection fields honestly empty —
// and the stamp moves forward. A version ahead of this build still refuses.

export const SCHEMA_VERSION = "2";

// The operational event ledger's own envelope version (ADR 0020): the
// run-level observation stream carries this, never the managed adapter's
// inner envelope version, which travels nested inside conversation events.
export const EVENT_ENVELOPE_VERSION = "clarification-events/v1";

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

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The attempt origins: the Developer's manual acts, and the one
// coordinator-created retry that durable non-dispatch evidence permits.
export const ATTEMPT_ORIGINS = ["manual", "coordinator-retry"];

const SCHEMA = `
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
  origin TEXT NOT NULL DEFAULT 'manual',
  outcome_kind TEXT,
  outcome_classification TEXT,
  outcome_next_action TEXT,
  outcome_reason TEXT,
  outcome_signature TEXT,
  outcome_at TEXT,
  dispatched TEXT,
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
CREATE TABLE IF NOT EXISTS failure_signatures (
  host_repo TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  signature TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_attempt_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (host_repo, run_id, signature)
);
CREATE TABLE IF NOT EXISTS escalations (
  host_repo TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  signature TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (host_repo, run_id, signature)
);
CREATE TABLE IF NOT EXISTS usage_lines (
  host_repo TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  line_id TEXT NOT NULL,
  attempt_id TEXT,
  kind TEXT NOT NULL,
  unit TEXT NOT NULL,
  value REAL,
  detail TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (host_repo, run_id, line_id)
);
`;

// The one coordinator retry per run, enforced by the schema itself — the
// partial unique index makes a second coordinator-created attempt on one
// run a constraint failure, not a judgment call.
const RETRY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_coordinator_retry
  ON attempts (run_id) WHERE origin = 'coordinator-retry';
`;

// The version-1 → version-2 migration: ticket #235's additive columns on
// attempts. Tables are already covered by CREATE TABLE IF NOT EXISTS.
const V1_TO_V2_ATTEMPT_COLUMNS = [
  "origin TEXT NOT NULL DEFAULT 'manual'",
  "outcome_kind TEXT",
  "outcome_classification TEXT",
  "outcome_next_action TEXT",
  "outcome_reason TEXT",
  "outcome_signature TEXT",
  "outcome_at TEXT",
  "dispatched TEXT",
];

// Opens the store for one host repo. `clock` is injected so timestamps are
// deterministic under test; production uses wall time.
export const openClarificationStore = ({
  hostRepo,
  databasePath,
  eventLedgerLimit = 1000,
  clock = () => new Date().toISOString(),
}) => {
  if (!hostRepo || typeof hostRepo !== "string")
    throw storeError("invalid_store", "the clarification store must be opened for a host repo");
  if (!Number.isInteger(eventLedgerLimit) || eventLedgerLimit < 1)
    throw storeError("invalid_store", "the event ledger limit must be an integer of at least 1");

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = FULL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA);

  const versionRow = database
    .prepare("SELECT value FROM store_meta WHERE key = 'schema_version'")
    .get();
  if (versionRow === undefined) {
    database.exec(RETRY_INDEX);
    database
      .prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?)")
      .run(SCHEMA_VERSION);
  } else if (versionRow.value === SCHEMA_VERSION) {
    database.exec(RETRY_INDEX);
  } else if (versionRow.value === "1") {
    // The additive migration: a version-1 file gains this build's columns
    // in one transaction, then takes the new stamp. A crash mid-migration
    // rolls back to a valid version-1 file.
    database.exec("BEGIN");
    try {
      for (const column of V1_TO_V2_ATTEMPT_COLUMNS)
        database.exec(`ALTER TABLE attempts ADD COLUMN ${column};`);
      database.exec(RETRY_INDEX);
      database
        .prepare("UPDATE store_meta SET value = ? WHERE key = 'schema_version'")
        .run(SCHEMA_VERSION);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } else {
    database.close();
    throw storeError(
      "unsupported_schema_version",
      `the clarification store was written by schema version ${versionRow.value}; this build reads ${SCHEMA_VERSION} and refuses to guess`,
    );
  }

  const insertRun = database.prepare(
    "INSERT INTO runs (run_id, host_repo, issue_id, request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertAttempt = database.prepare(
    "INSERT INTO attempts (attempt_id, run_id, host_repo, request_id, dispatch_intent, state, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const runRow = (row) =>
    row === undefined
      ? null
      : {
          runId: row.run_id,
          hostRepo: row.host_repo,
          issueId: row.issue_id,
          requestId: row.request_id,
          state: row.state,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };

  const attemptRow = (row) => {
    if (row === undefined) return null;
    const outcome =
      row.outcome_kind === null
        ? null
        : {
            kind: row.outcome_kind,
            classification: row.outcome_classification,
            nextAction: row.outcome_next_action,
            ...(row.outcome_reason === null ? {} : { reason: row.outcome_reason }),
            ...(row.outcome_signature === null ? {} : { signature: row.outcome_signature }),
            at: row.outcome_at,
          };
    const dispatched = row.dispatched === null ? null : JSON.parse(row.dispatched);
    return {
      attemptId: row.attempt_id,
      runId: row.run_id,
      hostRepo: row.host_repo,
      requestId: row.request_id,
      dispatchIntent: JSON.parse(row.dispatch_intent),
      state: row.state,
      origin: row.origin,
      ...(outcome === null ? {} : { outcome }),
      ...(dispatched === null ? {} : { dispatchedAt: dispatched.at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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

  // The ledger append, inside a caller's transaction: assigns the per-run
  // cursors and inserts each event. The public appendEvents wraps this in
  // its own transaction; the combined transition commands run it inside
  // theirs, so an event and the record move it evidences commit together.
  const appendEventsInTransaction = ({ runId, events, now }) => {
    if (!Array.isArray(events) || events.length === 0)
      throw storeError("invalid_request", "an append carries at least one event");
    for (const event of events)
      if (event === null || typeof event !== "object" || Array.isArray(event))
        throw storeError("invalid_request", "every ledger event is a JSON object");
    if (ownRun(runId) === undefined)
      throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
    return events.map((event) => {
      // Earlier inserts of this same batch are already visible inside the
      // transaction, so the per-row MAX is the whole sequence.
      const cursor =
        database
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE host_repo = ? AND run_id = ?",
          )
          .get(hostRepo, runId).seq + 1;
      database
        .prepare(
          "INSERT INTO events (host_repo, run_id, seq, event, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(hostRepo, runId, cursor, JSON.stringify(event), now);
      return { cursor, envelope: EVENT_ENVELOPE_VERSION, event };
    });
  };

  // One compare-and-set transition for runs and attempts, optionally
  // carrying ledger events and — for attempts — an outcome verdict: events,
  // the state move, and the verdict commit as one transaction, so the
  // durable record and its evidence cannot disagree, and an illegal
  // transition writes nothing at all. The UPDATE only lands while the row
  // still sits in the state the check read, so two writers can never drive
  // a forbidden state (last write wins is not a transition). A lost race
  // re-reads and reports against reality.
  const transitionState = ({ table, idColumn, what, notFoundCode }) => {
    const select = `SELECT * FROM ${table} WHERE ${idColumn} = ? AND host_repo = ?`;
    const rowMapper = table === "runs" ? runRow : attemptRow;
    return ({ id, to, events, verdict } = {}) => {
      const row = database.prepare(select).get(id, hostRepo);
      if (row === undefined)
        throw storeError(notFoundCode, `no ${what} "${id}" is visible to this host repo`);
      applyTransition({ current: row.state, to, what });
      const now = clock();
      database.exec("BEGIN");
      try {
        if (events !== undefined)
          appendEventsInTransaction({
            runId: table === "attempts" ? row.run_id : id,
            events,
            now,
          });
        const withVerdict = verdict !== undefined;
        if (withVerdict && table !== "attempts")
          throw storeError("invalid_request", "only an attempt carries an outcome verdict");
        if (withVerdict) {
          for (const field of ["kind", "classification", "nextAction", "at"])
            if (typeof verdict[field] !== "string" || verdict[field] === "")
              throw storeError("invalid_request", `an outcome verdict needs a ${field}`);
          if (
            verdict.signature !== undefined &&
            verdict.signature !== null &&
            typeof verdict.signature !== "string"
          )
            throw storeError("invalid_request", "an outcome verdict's signature is a string");
        }
        const update = `UPDATE ${table} SET state = ?, updated_at = ?${
          withVerdict
            ? ", outcome_kind = ?, outcome_classification = ?, outcome_next_action = ?, outcome_reason = ?, outcome_signature = ?, outcome_at = ?"
            : ""
        } WHERE ${idColumn} = ? AND host_repo = ? AND state = ?`;
        const result = withVerdict
          ? database
              .prepare(update)
              .run(
                to,
                now,
                verdict.kind,
                verdict.classification,
                verdict.nextAction,
                verdict.reason ?? null,
                verdict.signature ?? null,
                verdict.at,
                id,
                hostRepo,
                row.state,
              )
          : database.prepare(update).run(to, now, id, hostRepo, row.state);
        if (result.changes === 0) {
          const reality = database.prepare(select).get(id, hostRepo);
          throw storeError(
            "illegal_transition",
            `a ${what} in state "${reality?.state ?? "???"}" cannot move to "${to}" — another writer moved it first`,
          );
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return rowMapper(database.prepare(select).get(id, hostRepo));
    };
  };

  const transitionRun = transitionState({
    table: "runs",
    idColumn: "run_id",
    what: "run",
    notFoundCode: "run_not_found",
  });
  const transitionAttempt = transitionState({
    table: "attempts",
    idColumn: "attempt_id",
    what: "attempt",
    notFoundCode: "attempt_not_found",
  });

  return {
    close() {
      database.close();
    },

    // One Operational run record per approved work intent. The approval
    // travels as the client's run request id — a replayed approval (the same
    // request across a reconnect) returns the existing run with created:
    // false, never a second Operational record.
    createRun({ issueId, requestId }) {
      if (!issueId || typeof issueId !== "string")
        throw storeError("invalid_request", "a run needs an issue id");
      if (requestId === undefined || typeof requestId !== "string" || requestId.trim() === "")
        throw storeError("invalid_request", "a run needs a non-empty request id");

      const replayed = database
        .prepare("SELECT * FROM runs WHERE host_repo = ? AND request_id = ?")
        .get(hostRepo, requestId);
      if (replayed !== undefined) return { run: runRow(replayed), created: false };

      const now = clock();
      const run = {
        runId: `run_${randomUUID()}`,
        hostRepo,
        issueId,
        requestId,
        state: "active",
        createdAt: now,
        updatedAt: now,
      };
      try {
        insertRun.run(
          run.runId,
          run.hostRepo,
          run.issueId,
          run.requestId,
          run.state,
          run.createdAt,
          run.updatedAt,
        );
      } catch (error) {
        // A concurrent opener won the (host_repo, request_id) race: the
        // constraint is the dedup, and the winner's run is the answer.
        if (!/UNIQUE constraint failed/.test(String(error?.message))) throw error;
        return {
          run: runRow(
            database
              .prepare("SELECT * FROM runs WHERE host_repo = ? AND request_id = ?")
              .get(hostRepo, requestId),
          ),
          created: false,
        };
      }
      return { run, created: true };
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
      return transitionRun({ id: runId, to });
    },

    // The durable dispatch intent: the attempt identity, the deduplicated
    // client request id, and the intent commit atomically here — before the
    // coordinator performs any side effect. A repeated request (the same
    // run, the same request id — a reconnect replay) returns the existing
    // attempt with created: false; a genuine retry carries a new request id
    // and gets a fresh attempt identity. The origin records who created the
    // attempt: the Developer's manual act, or the one coordinator retry the
    // partial unique index permits per run — a second is a typed refusal,
    // even under a different request id.
    createAttempt({ runId, requestId, intent: dispatchIntent, origin = "manual" }) {
      if (requestId === undefined || typeof requestId !== "string" || requestId.trim() === "")
        throw storeError("invalid_request", "an attempt needs a non-empty request id");
      if (
        dispatchIntent === undefined ||
        dispatchIntent === null ||
        typeof dispatchIntent !== "object" ||
        Array.isArray(dispatchIntent)
      )
        throw storeError("invalid_request", "an attempt carries a dispatch intent object");
      if (!ATTEMPT_ORIGINS.includes(origin))
        throw storeError("invalid_request", `"${String(origin)}" is not an attempt origin`);
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
        origin,
        createdAt: now,
        updatedAt: now,
      };
      try {
        insertAttempt.run(
          attempt.attemptId,
          attempt.runId,
          attempt.hostRepo,
          attempt.requestId,
          JSON.stringify(attempt.dispatchIntent),
          attempt.state,
          attempt.origin,
          attempt.createdAt,
          attempt.updatedAt,
        );
      } catch (error) {
        const message = String(error?.message);
        // A UNIQUE failure is either the (run_id, request_id) dedup — in
        // which case the replayed attempt is the answer — or the one-
        // coordinator-retry index, whose spent refusal is typed. Which one
        // it was is read off reality, not off a constraint-name string.
        if (/UNIQUE constraint failed/.test(message)) {
          const winner = database
            .prepare("SELECT * FROM attempts WHERE run_id = ? AND request_id = ? AND host_repo = ?")
            .get(runId, requestId, hostRepo);
          if (winner !== undefined) return { attempt: attemptRow(winner), created: false };
          throw storeError(
            "coordinator_retry_spent",
            `run "${runId}" has already used its one coordinator retry`,
          );
        }
        throw error;
      }
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

    // The state move with its evidence: `events` and `verdict` ride the
    // same transaction as the transition, so an outcome event and the
    // lifecycle move it drives can never be observed apart.
    updateAttemptState({ attemptId, to, events, verdict }) {
      return transitionAttempt({ id: attemptId, to, events, verdict });
    },

    // The dispatch mark: durable evidence that the managed runtime became
    // ready and the dispatch window opened for this attempt. It lands once,
    // on an active attempt, in the same commit as its ledger event — after
    // this, "no dispatch occurred" can never be proven again.
    markAttemptDispatched({ attemptId, at, evidence } = {}) {
      if (typeof at !== "string" || at === "")
        throw storeError("invalid_request", "a dispatch mark needs a timestamp");
      if (evidence !== undefined && evidence !== null && !isPlainObject(evidence))
        throw storeError("invalid_request", "dispatch evidence travels verbatim as an object");
      const row = ownAttempt(attemptId);
      if (row === undefined)
        throw storeError(
          "attempt_not_found",
          `no attempt "${attemptId}" is visible to this host repo`,
        );
      if (row.state !== "active")
        throw storeError(
          "dispatch_not_markable",
          `attempt "${attemptId}" is ${row.state} — a dispatch mark records a live attempt's evidence`,
        );
      if (row.dispatched !== null)
        throw storeError(
          "dispatch_marked",
          `attempt "${attemptId}" already carries a dispatch mark`,
        );
      database.exec("BEGIN");
      try {
        database
          .prepare(
            "UPDATE attempts SET dispatched = ?, updated_at = ? WHERE attempt_id = ? AND host_repo = ? AND dispatched IS NULL",
          )
          .run(JSON.stringify({ at, evidence: evidence ?? null }), clock(), attemptId, hostRepo);
        appendEventsInTransaction({
          runId: row.run_id,
          events: [{ type: "dispatch", scope: "attempt", id: attemptId, at }],
          now: clock(),
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return attemptRow(ownAttempt(attemptId));
    },

    // The no-progress detector's durable counter: one row per (run,
    // signature), counting the attempts that failed identically. Reads back
    // across restarts, so a loop cannot hide by spanning them.
    recordFailureSignature({ runId, signature, attemptId }) {
      if (typeof signature !== "string" || signature === "")
        throw storeError("invalid_request", "a failure signature is a non-empty string");
      if (ownRun(runId) === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
      if (ownAttempt(attemptId) === undefined)
        throw storeError(
          "attempt_not_found",
          `no attempt "${attemptId}" is visible to this host repo`,
        );
      const row = database
        .prepare(
          `INSERT INTO failure_signatures (host_repo, run_id, signature, count, last_attempt_id, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT (host_repo, run_id, signature)
           DO UPDATE SET count = count + 1, last_attempt_id = excluded.last_attempt_id, updated_at = excluded.updated_at
           RETURNING count`,
        )
        .get(hostRepo, runId, signature, attemptId, clock());
      return { count: row.count };
    },

    // The no-progress halt, atomic: the escalation record inserts (its
    // (run, signature) key is unique, so one signature escalates once — a
    // repeat is a typed already_halted), the escalation event lands in the
    // ledger, and an active run moves to awaiting-human. A run already
    // parked or beyond that still records the handoff — the park is
    // idempotent, the record is not lost.
    haltRun({ runId, record }) {
      if (record === null || typeof record !== "object" || Array.isArray(record))
        throw storeError("invalid_request", "an escalation record is an object");
      for (const field of ["signature", "attemptId", "at"])
        if (typeof record[field] !== "string" || record[field] === "")
          throw storeError("invalid_request", `an escalation record needs a ${field}`);
      if ("type" in record || "scope" in record || "id" in record)
        throw storeError(
          "invalid_request",
          "an escalation record carries its identity from the run — no type, scope, or id fields",
        );
      if (ownRun(runId) === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);

      // The event carries the record's fields; the run's identity rides the
      // envelope's scope and id, so it is not duplicated inside.
      const { runId: _recordRunId, ...recordFields } = record;
      const event = { type: "escalation", scope: "run", id: runId, ...recordFields };
      database.exec("BEGIN");
      try {
        database
          .prepare(
            "INSERT INTO escalations (host_repo, run_id, signature, record, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(hostRepo, runId, record.signature, JSON.stringify(record), clock());
        appendEventsInTransaction({ runId, events: [event], now: clock() });
        // Only an active run is parked; the compare-and-set keeps the write
        // on the legal transition alone.
        const moved =
          database
            .prepare(
              "UPDATE runs SET state = 'awaiting-human', updated_at = ? WHERE run_id = ? AND host_repo = ? AND state = 'active'",
            )
            .run(clock(), runId, hostRepo).changes === 1;
        database.exec("COMMIT");
        return { record, moved };
      } catch (error) {
        database.exec("ROLLBACK");
        if (/UNIQUE constraint failed/.test(String(error?.message)))
          throw storeError(
            "already_halted",
            `run "${runId}" already escalated signature "${record.signature}"`,
          );
        throw error;
      }
    },

    // The durable usage budget: lines appended to the run's envelope, each
    // carrying its own kind — reported, estimated, unknown — and never
    // converted. Shapes are checked here so bad data never lands; the
    // closed kind vocabulary is the policy layer's to enforce.
    appendUsageLines({ runId, lines }) {
      if (!Array.isArray(lines) || lines.length === 0)
        throw storeError("invalid_request", "a usage append carries at least one line");
      const now = clock();
      if (ownRun(runId) === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
      const prepared = lines.map((line) => {
        if (line === null || typeof line !== "object" || Array.isArray(line))
          throw storeError("invalid_request", "a usage line is an object");
        if (typeof line.kind !== "string" || line.kind === "")
          throw storeError("invalid_request", "a usage line names its kind");
        if (typeof line.unit !== "string" || line.unit.trim() !== line.unit || line.unit === "")
          throw storeError("invalid_request", "a usage line names its unit");
        if (
          line.value !== undefined &&
          line.value !== null &&
          (typeof line.value !== "number" || !Number.isFinite(line.value) || line.value < 0)
        )
          throw storeError(
            "invalid_request",
            "a usage line's value is a finite non-negative number",
          );
        if (
          line.detail !== undefined &&
          line.detail !== null &&
          (typeof line.detail !== "object" || Array.isArray(line.detail))
        )
          throw storeError("invalid_request", "a usage line's detail is an object");
        if (
          line.attemptId !== undefined &&
          line.attemptId !== null &&
          ownAttempt(line.attemptId)?.run_id !== runId
        )
          throw storeError(
            "attempt_not_found",
            `no attempt "${line.attemptId}" is visible on run "${runId}" in this host repo`,
          );
        return {
          lineId: `usage_${randomUUID()}`,
          runId,
          attemptId: line.attemptId ?? null,
          kind: line.kind,
          unit: line.unit,
          value: typeof line.value === "number" ? line.value : null,
          detail: line.detail ?? null,
          createdAt: now,
        };
      });
      database.exec("BEGIN");
      try {
        for (const line of prepared)
          database
            .prepare(
              "INSERT INTO usage_lines (host_repo, run_id, line_id, attempt_id, kind, unit, value, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              hostRepo,
              line.runId,
              line.lineId,
              line.attemptId,
              line.kind,
              line.unit,
              line.value,
              line.detail === null ? null : JSON.stringify(line.detail),
              line.createdAt,
            );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return prepared.map((line) => ({
        lineId: line.lineId,
        ...(line.attemptId === null ? {} : { attemptId: line.attemptId }),
        kind: line.kind,
        unit: line.unit,
        value: line.value,
        ...(line.detail === null ? {} : { detail: JSON.parse(JSON.stringify(line.detail)) }),
        createdAt: line.createdAt,
      }));
    },

    usageBudgetFor(runId) {
      if (ownRun(runId) === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
      const lines = database
        .prepare("SELECT * FROM usage_lines WHERE run_id = ? AND host_repo = ? ORDER BY rowid ASC")
        .all(runId, hostRepo)
        .map((row) => ({
          lineId: row.line_id,
          ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
          kind: row.kind,
          unit: row.unit,
          value: row.value,
          ...(row.detail === null ? {} : { detail: JSON.parse(row.detail) }),
          createdAt: row.created_at,
        }));
      return { runId, lines };
    },

    listEscalations(runId) {
      if (ownRun(runId) === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
      return database
        .prepare(
          "SELECT record FROM escalations WHERE run_id = ? AND host_repo = ? ORDER BY created_at ASC, signature ASC",
        )
        .all(runId, hostRepo)
        .map((row) => JSON.parse(row.record));
    },

    // The operational event ledger (ADR 0020): a bounded, sequenced record
    // of one run's lifecycle and conversation events. The append commits
    // atomically — one transaction assigns the per-run cursors and persists
    // every event — so the moment this returns, the events are durable
    // evidence a reader (and any viewer publication) can be served from.
    // Events are evidence: they are stored verbatim, never interpreted.
    appendEvents({ runId, events }) {
      if (!Array.isArray(events) || events.length === 0)
        throw storeError("invalid_request", "an append carries at least one event");
      for (const event of events)
        if (event === null || typeof event !== "object" || Array.isArray(event))
          throw storeError("invalid_request", "every ledger event is a JSON object");
      if (ownRun(runId) === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);

      const now = clock();
      database.exec("BEGIN");
      try {
        const persisted = appendEventsInTransaction({ runId, events, now });
        // The bound is enforced inside the same transaction: retention is
        // part of the append, so an expired cursor can only ever name events
        // the ledger truly no longer holds.
        database
          .prepare("DELETE FROM events WHERE host_repo = ? AND run_id = ? AND seq <= ?")
          .run(
            hostRepo,
            runId,
            database
              .prepare("SELECT MAX(seq) AS seq FROM events WHERE host_repo = ? AND run_id = ?")
              .get(hostRepo, runId).seq - eventLedgerLimit,
          );
        database.exec("COMMIT");
        return persisted;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    // The events-after-cursor read reconnect is answered from: every
    // retained envelope after `afterCursor`, the latest cursor, and — when
    // the viewer's cursor predates the ledger's retention — the explicit
    // gap naming the first retained cursor. History is never invented: the
    // gap says exactly what cannot be served.
    readEvents({ runId, afterCursor }) {
      if (!Number.isInteger(afterCursor) || afterCursor < 0)
        throw storeError("invalid_request", "afterCursor must be a non-negative integer");
      if (ownRun(runId) === undefined)
        throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
      const bounds = database
        .prepare(
          "SELECT MIN(seq) AS first, MAX(seq) AS last FROM events WHERE host_repo = ? AND run_id = ?",
        )
        .get(hostRepo, runId);
      const latestCursor = bounds.last ?? 0;
      if (afterCursor > latestCursor)
        throw storeError(
          "invalid_cursor",
          `cursor ${afterCursor} is ahead of the ledger's latest cursor ${latestCursor} — no viewer has observed that yet`,
        );
      const events = database
        .prepare(
          "SELECT seq, event FROM events WHERE host_repo = ? AND run_id = ? AND seq > ? ORDER BY seq ASC",
        )
        .all(hostRepo, runId, afterCursor)
        .map((row) => ({
          cursor: row.seq,
          envelope: EVENT_ENVELOPE_VERSION,
          event: JSON.parse(row.event),
        }));
      // The gap: the viewer's cursor predates retention — the events between
      // its cursor and the first retained one are gone and are named as
      // gone, never skipped silently. An empty ledger holds nothing back.
      const firstRetained = bounds.first;
      const gap =
        typeof firstRetained === "number" && afterCursor < firstRetained - 1
          ? { after: afterCursor, firstRetainedCursor: firstRetained }
          : undefined;
      return { events, latestCursor, gap };
    },
  };
};
