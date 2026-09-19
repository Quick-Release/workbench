import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// The durable clarification store (spec #221, tickets #225, #226, #236, ADR
// 0020): the host-repo-scoped local SQLite metadata that everything else
// records into. One Operational run record per approved work intent; one
// Execution attempt per dispatch, each with a fresh identity; client Run
// requests deduplicated across reconnects. The lifecycle vocabulary and its
// legal transitions are the store's own — an illegal transition is a typed
// rejection, never a silent write.
//
// Ownership: every mutation travels under the run's Controller lease — an
// opaque token bound to an owner and a fencing generation; presenting the
// token is the owner match. The lease authorizes writes; it is never a
// heartbeat: reads report ownership and expiry arithmetic only, and the
// store never claims a process is alive or dead. Lease expiry permits
// reconciliation but not adoption: an expired token cannot write a late
// completion, cancellation, cleanup result, or retry decision, and once a
// newer generation exists the old token is fenced in full. A restart finds
// every record readable — inspection never needed a lease.
//
// Recovery: reconciliation — moving a run or attempt into `reconciling` and
// resolving it — is the store's own housekeeping on its own records:
// lease-free by design, fenced by lifecycle legality. It claims no external
// effect, so it needs no live lease; it also cannot claim one. Resolving to
// terminal cites the evidence it inspected (basis_required otherwise): a
// bare terminal conclusion is the false completion ADR 0020 forbids, and a
// live lease closes outcomes with results, not classifications. Process
// death is recorded the same lease-free way — it records the loss of proof,
// never an effect — as one transaction that lands the attempt and the run
// in `unknown` with the termination evidence (what is proven, what stays
// uncertain) on the attempt. Quarantined records cannot be reused and
// cannot be deleted until reconciliation or discard resolves them; the
// discard is the one destructive path and it is typed-confirmed: the caller
// echoes the run id it is destroying, and the ledger purge commits with the
// run's close so retained evidence cannot half-vanish.
//
// Evidence: operational events go into a bounded, per-run sequenced ledger,
// committed before this returns, so the coordinator can never publish what
// the store has not already persisted. Readers resume after a cursor; a
// cursor that predates the retained suffix reports an explicit gap —
// history is never invented to fill one — and a cursor past the ledger's
// end is refused.
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
// The schema is versioned. A file written by a newer store fails closed
// rather than being guessed at; older files migrate in place through
// read-compatible steps, so data written before a disable or upgrade stays
// interpretable.

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

// Where reconciliation may land. Terminal is a classification of inspected
// uncertainty — it must cite its evidence basis — while success-completions
// remain results written under a live lease.
export const RECONCILIATION_RESOLUTIONS = [
  "active",
  "awaiting-human",
  "unknown",
  "quarantined",
  "terminal",
];

// The run states whose retained evidence may be discarded: the recovery
// states a stuck record can sit in. A live run is not a discard target, and
// a terminal one has already closed.
const DISCARDABLE_STATES = ["unknown", "awaiting-human", "quarantined"];

export const DEFAULT_LEASE_TTL_MS = 30_000;

const storeError = (code, message) => Object.assign(new Error(message), { code });

// The table this ticket adds, defined once: the full schema and the v1→v2
// migration must not drift.
const LEASES_TABLE = `
CREATE TABLE IF NOT EXISTS leases (
  run_id TEXT PRIMARY KEY,
  host_repo TEXT NOT NULL,
  token TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);`;

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
  discarded_at TEXT,
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
  result TEXT,
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
${LEASES_TABLE}
`;

// v1 → v2: exactly the delta above that version 1 lacks — the lease table
// is new, and attempts and runs gain their result and discard columns. Rows
// version 1 wrote keep reading back; nothing is rewritten or guessed.
const MIGRATIONS = {
  1: (database) => {
    database.exec(LEASES_TABLE);
    database.exec("ALTER TABLE attempts ADD COLUMN result TEXT;");
    database.exec("ALTER TABLE runs ADD COLUMN discarded_at TEXT;");
  },
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToken = (value) => typeof value === "string" && value !== "";

// Opens the store for one host repo. `clock` is injected so timestamps and
// lease expiry are deterministic under test; production uses wall time.
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

  // One immediate transaction per write path: the write lock spans the
  // fence check and the row update, so no other writer can slip a newer
  // lease generation between the check and the write.
  const tx = (fn) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  // Idempotent on an older file: the IF NOT EXISTS leaves the existing
  // tables untouched, and the migration below adds only the delta.
  database.exec(SCHEMA);

  const versionRow = database
    .prepare("SELECT value FROM store_meta WHERE key = 'schema_version'")
    .get();
  if (versionRow === undefined) {
    database
      .prepare("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?)")
      .run(SCHEMA_VERSION);
  } else {
    const stored = Number(versionRow.value);
    // Anything this store family never wrote — a newer build's file, or a
    // stamp older than the first version, or garbage — fails closed.
    if (!Number.isInteger(stored) || stored < 1 || stored > Number(SCHEMA_VERSION)) {
      database.close();
      throw storeError(
        "unsupported_schema_version",
        `the clarification store was written by schema version ${versionRow.value}; this build reads ${SCHEMA_VERSION} and refuses to guess`,
      );
    }
    for (let version = stored; version < Number(SCHEMA_VERSION); version += 1)
      tx(() => {
        MIGRATIONS[version](database);
        database
          .prepare("UPDATE store_meta SET value = ? WHERE key = 'schema_version'")
          .run(String(version + 1));
      });
  }

  const insertRun = database.prepare(
    "INSERT INTO runs (run_id, host_repo, issue_id, request_id, state, created_at, updated_at, discarded_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
  );
  const insertAttempt = database.prepare(
    "INSERT INTO attempts (attempt_id, run_id, host_repo, request_id, dispatch_intent, state, created_at, updated_at, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
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
          discardedAt: row.discarded_at ?? null,
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
          result: row.result === null || row.result === undefined ? null : JSON.parse(row.result),
        };

  // Reads and writes always carry the host repo: a run from another repo is
  // invisible here, indistinguishable from one that does not exist.
  const ownRun = (runId) =>
    database.prepare("SELECT * FROM runs WHERE run_id = ? AND host_repo = ?").get(runId, hostRepo);

  const ownAttempt = (attemptId) =>
    database
      .prepare("SELECT * FROM attempts WHERE attempt_id = ? AND host_repo = ?")
      .get(attemptId, hostRepo);

  // The lease read model: ownership and expiry arithmetic, never the token
  // (the token is a capability, not a display fact) and never an
  // alive/dead claim (a lease is a claim on the record, not a heartbeat).
  const leaseRow = (row) => ({
    owner: row.owner,
    generation: row.generation,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    expired: Date.parse(row.expires_at) <= Date.parse(clock()),
  });

  const ownLease = (runId) =>
    database
      .prepare("SELECT * FROM leases WHERE run_id = ? AND host_repo = ?")
      .get(runId, hostRepo);

  // The lease gate's shared core: the presented token must be the run's
  // current lease, and the lease must be unexpired. Order matters — a
  // superseded generation is told it is fenced even when the current lease
  // has itself since expired. The expired message differs by caller (a
  // fenced mutation invites reconciliation; a renewal invites a fresh
  // acquisition), so it travels in.
  const requireCurrentLease = (runId, token, expiredMessage) => {
    const row = ownLease(runId);
    if (row === undefined)
      throw storeError("lease_required", `run "${runId}" holds no controller lease`);
    if (row.token !== token)
      throw storeError(
        "lease_not_held",
        `the token presented for run "${runId}" is not the current controller lease (generation ${row.generation}) — a stale generation cannot write`,
      );
    if (Date.parse(row.expires_at) <= Date.parse(clock()))
      throw storeError("lease_expired", expiredMessage(row.expires_at));
    return row;
  };

  // The gate every fenced mutation passes.
  const requireLiveLease = (runId, token) => {
    if (!isToken(token))
      throw storeError(
        "lease_required",
        `this mutation of run "${runId}" needs the controller lease token`,
      );
    return requireCurrentLease(
      runId,
      token,
      (expiresAt) =>
        `the controller lease for run "${runId}" expired at ${expiresAt} — expiry permits reconciliation, not adoption`,
    );
  };

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

  // One compare-and-set transition for runs and attempts: the UPDATE only
  // lands while the row still sits in the state the check read, so two
  // writers can never drive a forbidden state (last write wins is not a
  // transition). A lost race re-reads and reports against reality.
  const transitionState = ({ table, idColumn, what, notFoundCode }) => {
    const select = `SELECT * FROM ${table} WHERE ${idColumn} = ? AND host_repo = ?`;
    const update = `UPDATE ${table} SET state = ?, updated_at = ? WHERE ${idColumn} = ? AND host_repo = ? AND state = ?`;
    const rowMapper = table === "runs" ? runRow : attemptRow;
    return ({ id, to, leaseToken }) =>
      tx(() => {
        const row = database.prepare(select).get(id, hostRepo);
        if (row === undefined)
          throw storeError(notFoundCode, `no ${what} "${id}" is visible to this host repo`);
        requireLiveLease(row.run_id, leaseToken);
        applyTransition({ current: row.state, to, what });
        const result = database.prepare(update).run(to, clock(), id, hostRepo, row.state);
        if (result.changes === 0) {
          const reality = database.prepare(select).get(id, hostRepo);
          throw storeError(
            "illegal_transition",
            `a ${what} in state "${reality?.state ?? "???"}" cannot move to "${to}" — another writer moved it first`,
          );
        }
        return rowMapper(database.prepare(select).get(id, hostRepo));
      });
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

  // Append inside an open transaction: the per-run sequence is the ledger's
  // own, allocation and insert commit atomically with the caller's write,
  // and the bound trims the oldest rows — which is what makes an old cursor
  // honestly expired rather than silently rewritten.
  const appendEventsInTx = ({ runId, events, at }) => {
    const persisted = events.map((event) => {
      // Earlier inserts of this same batch are already visible inside
      // the transaction, so the per-row MAX is the whole sequence.
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
        .run(hostRepo, runId, cursor, JSON.stringify(event), at);
      return { cursor, envelope: EVENT_ENVELOPE_VERSION, event };
    });
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
    return persisted;
  };

  const lifecycleEvent = ({ scope, id, state, at, basis }) => ({
    type: "lifecycle",
    scope,
    id,
    state,
    at,
    ...(basis === undefined ? {} : { basis }),
  });

  // Reconciliation, run or attempt level: the lease-free way out of a stuck
  // record. Beginning moves the row into `reconciling`; resolving lands it
  // on a resolution target — terminal only with the evidence basis cited.
  // Each move CAS-writes and leaves its lifecycle event in the ledger in
  // the same commit.
  const reconciliation = ({ table, idColumn, what, notFoundCode, rowMapper, scope }) => {
    const select = `SELECT * FROM ${table} WHERE ${idColumn} = ? AND host_repo = ?`;
    return {
      begin: (id) => {
        const row = database.prepare(select).get(id, hostRepo);
        if (row === undefined)
          throw storeError(notFoundCode, `no ${what} "${id}" is visible to this host repo`);
        applyTransition({ current: row.state, to: "reconciling", what });
        const at = clock();
        return tx(() => {
          const current = database.prepare(select).get(id, hostRepo);
          if (current.state !== row.state)
            throw storeError(
              "illegal_transition",
              `a ${what} in state "${current.state}" cannot move to "reconciling" — another writer moved it first`,
            );
          database
            .prepare(
              `UPDATE ${table} SET state = 'reconciling', updated_at = ? WHERE ${idColumn} = ? AND host_repo = ? AND state = ?`,
            )
            .run(at, id, hostRepo, row.state);
          appendEventsInTx({
            runId: current.run_id,
            events: [lifecycleEvent({ scope, id, state: "reconciling", at })],
            at,
          });
          return rowMapper(database.prepare(select).get(id, hostRepo));
        });
      },
      resolve: (id, to, { basis } = {}) => {
        if (!LIFECYCLE_STATES.includes(to))
          throw storeError("unknown_state", `"${to}" is not a lifecycle state`);
        if (!RECONCILIATION_RESOLUTIONS.includes(to))
          throw storeError(
            "illegal_transition",
            `reconciliation resolves uncertainty; it cannot conclude "${to}" — a live lease closes outcomes`,
          );
        if (to === "terminal" && (typeof basis !== "string" || basis.trim() === ""))
          throw storeError(
            "basis_required",
            `concluding this ${what} as terminal is a classification of inspected evidence — cite the basis it rests on`,
          );
        const row = database.prepare(select).get(id, hostRepo);
        if (row === undefined)
          throw storeError(notFoundCode, `no ${what} "${id}" is visible to this host repo`);
        applyTransition({ current: row.state, to, what });
        const at = clock();
        return tx(() => {
          const current = database.prepare(select).get(id, hostRepo);
          if (current.state !== "reconciling")
            throw storeError(
              "illegal_transition",
              `a ${what} in state "${current.state}" is not being reconciled`,
            );
          database
            .prepare(
              `UPDATE ${table} SET state = ?, updated_at = ? WHERE ${idColumn} = ? AND host_repo = ? AND state = 'reconciling'`,
            )
            .run(to, at, id, hostRepo);
          appendEventsInTx({
            runId: current.run_id,
            events: [lifecycleEvent({ scope, id, state: to, at, basis })],
            at,
          });
          return rowMapper(database.prepare(select).get(id, hostRepo));
        });
      },
    };
  };

  const runReconciliation = reconciliation({
    table: "runs",
    idColumn: "run_id",
    what: "run",
    notFoundCode: "run_not_found",
    rowMapper: runRow,
    scope: "run",
  });
  const attemptReconciliation = reconciliation({
    table: "attempts",
    idColumn: "attempt_id",
    what: "attempt",
    notFoundCode: "attempt_not_found",
    rowMapper: attemptRow,
    scope: "attempt",
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
        discardedAt: null,
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

    updateRunState({ runId, to, leaseToken }) {
      return transitionRun({ id: runId, to, leaseToken });
    },

    // The Controller lease: an opaque token bound to an owner and a fencing
    // generation. Acquisition is refused while a live lease stands (the
    // caller learns who holds it and until when — the "controls moved"
    // facts, with no liveness claim); an expired lease yields to a new
    // generation, fencing every token before it.
    acquireLease({ runId, owner, ttlMs = DEFAULT_LEASE_TTL_MS }) {
      if (typeof owner !== "string" || owner.trim() === "")
        throw storeError("invalid_request", "a lease needs a non-empty owner");
      if (!Number.isInteger(ttlMs) || ttlMs <= 0)
        throw storeError("invalid_request", "a lease needs a positive ttl in milliseconds");

      return tx(() => {
        if (ownRun(runId) === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        const current = ownLease(runId);
        const now = clock();
        if (current !== undefined && Date.parse(current.expires_at) > Date.parse(now))
          throw storeError(
            "lease_held",
            `the controller lease for run "${runId}" is held by "${current.owner}" until ${current.expires_at}`,
          );
        const lease = {
          token: `lease_${randomUUID()}`,
          generation: (current?.generation ?? 0) + 1,
          owner,
          acquiredAt: now,
          expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
        };
        database
          .prepare(
            "INSERT INTO leases (run_id, host_repo, token, generation, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET token = excluded.token, generation = excluded.generation, owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at",
          )
          .run(
            runId,
            hostRepo,
            lease.token,
            lease.generation,
            lease.owner,
            lease.acquiredAt,
            lease.expiresAt,
          );
        return { lease };
      });
    },

    // Renewal moves the window, never the identity or the generation: an
    // expired lease cannot be revived in place — the holder re-enters
    // through a new acquisition, and everything it wrote under the old
    // generation stays fenced.
    renewLease({ runId, token, ttlMs = DEFAULT_LEASE_TTL_MS }) {
      if (!Number.isInteger(ttlMs) || ttlMs <= 0)
        throw storeError("invalid_request", "a lease needs a positive ttl in milliseconds");
      return tx(() => {
        const row = requireCurrentLease(
          runId,
          token,
          (expiresAt) =>
            `the controller lease for run "${runId}" expired at ${expiresAt} — acquire a new generation instead`,
        );
        const now = clock();
        const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
        database
          .prepare("UPDATE leases SET expires_at = ? WHERE run_id = ? AND host_repo = ?")
          .run(expiresAt, runId, hostRepo);
        return {
          lease: {
            token: row.token,
            generation: row.generation,
            owner: row.owner,
            acquiredAt: row.acquired_at,
            expiresAt,
          },
        };
      });
    },

    // Ownership and expiry arithmetic only — never the token, never an
    // alive/dead claim.
    getLease(runId) {
      const row = ownLease(runId);
      return row === undefined ? null : leaseRow(row);
    },

    // The durable dispatch intent: the attempt identity, the deduplicated
    // client request id, and the intent commit atomically here — before the
    // coordinator performs any side effect. A repeated request (the same
    // run, the same request id — a reconnect replay) returns the existing
    // attempt with created: false — a read, not a mutation, so it needs no
    // lease; a genuine retry decision carries a new request id, travels
    // under the live controller lease, and gets a fresh attempt identity.
    createAttempt({ runId, requestId, intent: dispatchIntent, leaseToken }) {
      if (requestId === undefined || typeof requestId !== "string" || requestId.trim() === "")
        throw storeError("invalid_request", "an attempt needs a non-empty request id");
      if (
        dispatchIntent === undefined ||
        dispatchIntent === null ||
        typeof dispatchIntent !== "object" ||
        Array.isArray(dispatchIntent)
      )
        throw storeError("invalid_request", "an attempt carries a dispatch intent object");
      return tx(() => {
        const row = ownRun(runId);
        if (row === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);

        const replayed = database
          .prepare("SELECT * FROM attempts WHERE run_id = ? AND request_id = ? AND host_repo = ?")
          .get(runId, requestId, hostRepo);
        if (replayed !== undefined) return { attempt: attemptRow(replayed), created: false };

        // Gate, state rule, and insert share one immediate transaction: the
        // retry decision is fenced at the write, not only at the check.
        requireLiveLease(runId, leaseToken);
        if (row.state !== "active")
          throw storeError(
            "run_not_active",
            `run "${runId}" is ${row.state} — new attempts start only on an active run`,
          );

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
          result: null,
        };
        try {
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
        } catch (error) {
          // A concurrent opener won the (run_id, request_id) race between the
          // replay check and the insert: the constraint is the dedup, and the
          // winner's attempt is the answer.
          if (!/UNIQUE constraint failed/.test(String(error?.message))) throw error;
          return {
            attempt: attemptRow(
              database
                .prepare(
                  "SELECT * FROM attempts WHERE run_id = ? AND request_id = ? AND host_repo = ?",
                )
                .get(runId, requestId, hostRepo),
            ),
            created: false,
          };
        }
        return { attempt, created: true };
      });
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

    updateAttemptState({ attemptId, to, leaseToken }) {
      return transitionAttempt({ id: attemptId, to, leaseToken });
    },

    // The fenced result write: a completion, a cancellation, a cleanup
    // result, or a termination's recorded proof and uncertainty. It claims
    // an effect on the world, so it travels under the live lease like every
    // mutation that claims one — and it is write-once: a recorded result is
    // evidence of an outcome, so a later write (even the live controller's)
    // is refused rather than allowed to rewrite history. A correction is a
    // new attempt, never an edit.
    recordAttemptResult({ attemptId, result, leaseToken }) {
      if (!isPlainObject(result) || typeof result.kind !== "string" || result.kind.trim() === "")
        throw storeError("invalid_request", "an attempt result carries a non-empty kind");
      return tx(() => {
        const row = ownAttempt(attemptId);
        if (row === undefined)
          throw storeError(
            "attempt_not_found",
            `no attempt "${attemptId}" is visible to this host repo`,
          );
        requireLiveLease(row.run_id, leaseToken);
        const updated = database
          .prepare(
            "UPDATE attempts SET result = ?, updated_at = ? WHERE attempt_id = ? AND host_repo = ? AND result IS NULL",
          )
          .run(JSON.stringify(result), clock(), attemptId, hostRepo);
        if (updated.changes === 0)
          throw storeError(
            "result_recorded",
            `the attempt "${attemptId}" already carries a recorded result — outcomes are evidence, first-write-wins; a correction is a new attempt`,
          );
        return attemptRow(ownAttempt(attemptId));
      });
    },

    // Process death, recorded: one transaction lands the attempt and the
    // run in `unknown` with the termination evidence on the attempt. It is
    // lease-free on purpose — it records the LOSS of proof, claims no
    // effect, and must be writable exactly when the lease is gone (the
    // holder is what died). This is a deliberate reading of ADR 0020's
    // "every mutating operation requires a controller lease": the moves
    // fenced by the lease are the ones claiming an effect (a completion, a
    // cancellation, a cleanup result, a retry); recording that proof is
    // gone claims nothing and must not require the very holder that died.
    // The evidence separates what is proven (the runtime's observed exit,
    // when it was observed) from what stays uncertain at this tier: the
    // fate of the runtime's descendant processes, and the exit itself when
    // it went unobserved. Proving a descendant kill is the caller's to
    // record, through the fenced result write, when it truly has that
    // proof. A second death report, an unknown attempt, or an attempt of
    // another run is a typed rejection — and an already-recorded result is
    // kept, never rewritten (COALESCE).
    recordProcessDeath({ runId, attemptId, exit }) {
      if (exit !== null && typeof exit !== "number")
        throw storeError(
          "invalid_request",
          "a process death carries the observed exit status, or null when it was not observed",
        );
      const at = clock();
      return tx(() => {
        const run = ownRun(runId);
        if (run === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        const attempt = ownAttempt(attemptId);
        if (attempt === undefined || attempt.run_id !== runId)
          throw storeError(
            "attempt_not_found",
            `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
          );
        applyTransition({ current: attempt.state, to: "unknown", what: "attempt" });
        applyTransition({ current: run.state, to: "unknown", what: "run" });

        const attemptUpdate = database
          .prepare(
            "UPDATE attempts SET state = 'unknown', result = COALESCE(result, ?), updated_at = ? WHERE attempt_id = ? AND host_repo = ? AND state = ?",
          )
          .run(
            JSON.stringify({
              kind: "termination",
              at,
              proof: exit === null ? {} : { runtimeExit: exit },
              uncertainty:
                exit === null
                  ? ["runtime-exit", "descendant-termination"]
                  : ["descendant-termination"],
            }),
            at,
            attemptId,
            hostRepo,
            attempt.state,
          );
        if (attemptUpdate.changes === 0)
          throw storeError(
            "illegal_transition",
            `the attempt "${attemptId}" moved past "${attempt.state}" — another writer recorded the outcome first`,
          );
        const runUpdate = database
          .prepare(
            "UPDATE runs SET state = 'unknown', updated_at = ? WHERE run_id = ? AND host_repo = ? AND state = ?",
          )
          .run(at, runId, hostRepo, run.state);
        if (runUpdate.changes === 0)
          throw storeError(
            "illegal_transition",
            `the run "${runId}" moved past "${run.state}" — another writer recorded the outcome first`,
          );
        appendEventsInTx({
          runId,
          events: [
            lifecycleEvent({ scope: "attempt", id: attemptId, state: "unknown", at }),
            lifecycleEvent({ scope: "run", id: runId, state: "unknown", at }),
          ],
          at,
        });
        return { run: runRow(ownRun(runId)), attempt: attemptRow(ownAttempt(attemptId)) };
      });
    },

    // Reconciliation, run level: lease-free by design (see the module head).
    beginReconciliation({ runId }) {
      return runReconciliation.begin(runId);
    },

    resolveReconciliation({ runId, to, basis }) {
      return runReconciliation.resolve(runId, to, { basis });
    },

    // Reconciliation, attempt level.
    beginAttemptReconciliation({ attemptId }) {
      return attemptReconciliation.begin(attemptId);
    },

    resolveAttemptReconciliation({ attemptId, to, basis }) {
      return attemptReconciliation.resolve(attemptId, to, { basis });
    },

    // The typed destructive discard: the one path that deletes retained
    // evidence. The confirmation echoes the run id — the caller names what
    // it destroys — and the whole discard is one commit: the run closes
    // terminal with the discard stamped on it, and the ledger is purged
    // with it, so evidence cannot half-vanish. Lease-free like
    // reconciliation — a deliberate reading of ADR 0020's "every mutating
    // operation requires a controller lease", flagged here for the ADR's
    // owner: a quarantined record's controller is exactly what may no
    // longer exist, and requiring a live lease would make an orphaned
    // record undeletable forever; the typed confirmation is the authority.
    // Awaiting-human counts as discardable on purpose: parked for a human
    // decision includes the decision to discard. The attempt rows survive
    // as records; the event evidence does not.
    discardRunEvidence({ runId, confirmation }) {
      if (confirmation !== runId)
        throw storeError(
          "discard_unconfirmed",
          `discarding run "${runId}"'s retained evidence is destructive and irreversible — pass { confirmation: "${runId}" } to confirm`,
        );
      const at = clock();
      return tx(() => {
        const row = ownRun(runId);
        if (row === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        if (!DISCARDABLE_STATES.includes(row.state))
          throw storeError(
            "illegal_transition",
            `a run in state "${row.state}" has no discardable retained evidence — reconcile or resolve it first`,
          );
        const updated = database
          .prepare(
            "UPDATE runs SET state = 'terminal', discarded_at = ?, updated_at = ? WHERE run_id = ? AND host_repo = ? AND state = ?",
          )
          .run(at, at, runId, hostRepo, row.state);
        if (updated.changes === 0)
          throw storeError(
            "illegal_transition",
            `the run "${runId}" moved past "${row.state}" — another writer resolved it first`,
          );
        database
          .prepare("DELETE FROM events WHERE host_repo = ? AND run_id = ?")
          .run(hostRepo, runId);
        return runRow(ownRun(runId));
      });
    },

    // The operational event ledger (ADR 0020): a bounded, sequenced record
    // of one run's lifecycle and conversation events. The append commits
    // atomically — one transaction assigns the per-run cursors and persists
    // every event — so the moment this returns, the events are durable
    // evidence a reader (and any viewer publication) can be served from.
    // Events are evidence: they are stored verbatim, never interpreted.
    // Appending evidence claims a write on the record, so it travels under
    // the live lease like every mutation.
    appendEvents({ runId, events, leaseToken }) {
      if (!Array.isArray(events) || events.length === 0)
        throw storeError("invalid_request", "an append carries at least one event");
      for (const event of events)
        if (event === null || typeof event !== "object" || Array.isArray(event))
          throw storeError("invalid_request", "every ledger event is a JSON object");
      return tx(() => {
        if (ownRun(runId) === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        requireLiveLease(runId, leaseToken);
        return appendEventsInTx({ runId, events, at: clock() });
      });
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
