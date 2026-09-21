import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// The durable clarification store (spec #221, tickets #225 + #226, ADR 0020):
// the host-repo-scoped local SQLite metadata everything else records into.
// One Operational run record per approved work intent; one Execution attempt
// per dispatch, each with a fresh identity; client Run requests deduplicated
// across reconnects. The lifecycle vocabulary and its legal transitions are
// the store's own — an illegal transition is a typed rejection, never a
// silent write.
//
// Ownership: every mutation below run creation travels under the run's
// Controller lease — an opaque token bound to an owner and a fencing
// generation; presenting the token is the owner match. The lease authorizes
// writes; it is never a heartbeat: reads report ownership and expiry
// arithmetic only, and the store never claims a process is alive or dead.
// Lease expiry permits reconciliation but not adoption: an expired token
// cannot write a late completion, cancellation, cleanup result, or retry
// decision, and once a newer generation exists the old token is fenced in
// full. Reconciliation — moving a run or attempt into `reconciling` and
// resolving it to active/awaiting-human/unknown/quarantined — is the store's
// own housekeeping on its own records: lease-free by design, fenced by
// lifecycle legality, and never concluding a terminal outcome. A live lease
// closes outcomes; reconciliation resolves uncertainty.
//
// Evidence: operational events go into a bounded, per-run sequenced ledger.
// appendEvent commits (WAL, synchronous FULL) before it returns, so
// persistence always precedes viewer publication. Readers resume after a
// cursor; a cursor that predates the retained suffix reports an explicit gap
// — history is never invented to fill one — and a cursor past the ledger's
// end is refused. A per-run snapshot is the reconnect baseline the
// events-after-cursor replay tops up; its write is fenced like every
// mutation, its read is open.
//
// Durability posture: creating an attempt IS the durable dispatch intent —
// the intent, the request id, and the fresh attempt identity commit
// atomically before the coordinator touches any side effect, and they read
// back across a close and reopen.
//
// The draft (ticket #233): one mutable document per attempt, latest write
// wins — the locally persisted proposal the Developer corrects until the
// brief is implementation-ready. Saving a draft is never publication
// approval: the write moves no lifecycle state and claims no effect on the
// world, but it lands on the run's record, so it is fenced like every
// write. The read is open, like every read.
//
// The failure policy's durables (ticket #235, ADR 0023): attempts record who
// created them (the Developer, or the one coordinator retry the partial
// unique index permits per run) and the dispatch mark — durable evidence
// that the dispatch window opened, after which "no dispatch occurred" can
// never be proven again. The no-progress detector counts bounded failure
// signatures per run; the halt's escalation records are a bounded handoff;
// the usage budget's lines keep reported, estimated, and unknown distinct.
// Every policy mutation is fenced like every write; the reads are open.
//
// The approval binding's durables (ticket #234, ADR 0014): one approval row
// per explicit Developer approval of the issue-body publication, carrying
// the full binding verbatim, a single-use nonce, and an expiry. The nonce
// is the approval's spendable identity: consumption is a compare-and-set
// from pending, so a second write attempt — even a raced one — is a typed
// refusal, never a second publication. Expiry is checked at consumption
// like the lease's: arithmetic against the clock, not trust in the caller.
// A gate-refused approval is marked stale and is then dead forever. The
// record is evidence: nothing here writes to the tracker.
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

export const SCHEMA_VERSION = "6";

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
// uncertainty — ticket #236's "reconciliation to a terminal or quarantined
// classification" — and it must cite the evidence it inspected
// (basis_required otherwise): a live lease closes outcomes with results, a
// resolution without a basis would be the false completion ADR 0020
// forbids.
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

// How long a recorded approval stays spendable. The approval is meant to be
// consumed immediately by the same act that recorded it; the window exists
// for the durable record's sake — an approval whose command died before the
// write reads back as expired, never as silently still-live forever.
export const DEFAULT_APPROVAL_TTL_MS = 300_000;

// The approval row's states. Pending is the only spendable one; consumed
// and stale are terminal records of why the nonce is dead.
export const APPROVAL_STATUSES = ["pending", "consumed", "stale"];

export const EVENT_LEDGER_LIMIT = 1000;

const storeError = (code, message) => Object.assign(new Error(message), { code });

// The tables this ticket adds, defined once: the full schema and the v1→v2
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
const RUN_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS run_snapshots (
  run_id TEXT PRIMARY KEY,
  host_repo TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  saved_at TEXT NOT NULL
);`;
const DRAFTS_TABLE = `
CREATE TABLE IF NOT EXISTS drafts (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  host_repo TEXT NOT NULL,
  draft TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
const FAILURE_SIGNATURES_TABLE = `
CREATE TABLE IF NOT EXISTS failure_signatures (
  host_repo TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  signature TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_attempt_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (host_repo, run_id, signature)
);`;
const ESCALATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS escalations (
  host_repo TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  signature TEXT NOT NULL,
  record TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (host_repo, run_id, signature)
);`;
const USAGE_LINES_TABLE = `
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
);`;
const APPROVALS_TABLE = `
CREATE TABLE IF NOT EXISTS approvals (
  nonce TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  host_repo TEXT NOT NULL,
  binding TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);`;

// The attempt origins: the Developer's manual acts, and the one
// coordinator-created retry that durable non-dispatch evidence permits.
export const ATTEMPT_ORIGINS = ["manual", "coordinator-retry"];

// The one coordinator retry per run, enforced by the schema itself — the
// partial unique index makes a second coordinator-created attempt on one
// run a constraint failure, not a judgment call.
const RETRY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS attempts_one_coordinator_retry
  ON attempts (run_id) WHERE origin = 'coordinator-retry';`;

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
  origin TEXT NOT NULL DEFAULT 'manual',
  dispatched TEXT,
  UNIQUE (run_id, request_id)
);
${LEASES_TABLE}
${RUN_SNAPSHOTS_TABLE}
${DRAFTS_TABLE}
${FAILURE_SIGNATURES_TABLE}
${ESCALATIONS_TABLE}
${USAGE_LINES_TABLE}
${APPROVALS_TABLE}
CREATE TABLE IF NOT EXISTS events (
  host_repo TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (host_repo, run_id, seq)
);
`;

// v1 → v2: exactly the delta above that version 1 lacks — the lease and
// snapshot tables are new, and attempts gain their result column. Rows
// version 1 wrote keep reading back; nothing is rewritten or guessed.
//
// v2 → v3: the drafts table is new (ticket #233) — the attempt's
// Clarification draft as one mutable document per attempt. Everything a v2
// file holds keeps reading back untouched.
//
// v3 → v4: the failure policy's durables (ticket #235) — attempts gain
// their origin and dispatch mark, the signature counters, escalation
// records, and usage budget lines arrive as new tables, and the one
// coordinator retry becomes the schema's own law. Everything a v3 file
// holds keeps reading back untouched.
//
// v4 → v5: runs gain their discard stamp (ticket #236) — set only by the
// typed destructive discard, so a closed record stays interpretable about
// how its retained evidence ended. Everything a v4 file holds keeps
// reading back untouched.
//
// v5 → v6: the approvals table is new (ticket #234) — one approval binding
// per explicit Developer approval of the issue-body publication, with its
// single-use nonce and expiry. Everything a v5 file holds keeps reading
// back untouched.
const MIGRATIONS = {
  1: (database) => {
    database.exec(`${LEASES_TABLE}
${RUN_SNAPSHOTS_TABLE}
ALTER TABLE attempts ADD COLUMN result TEXT;`);
  },
  2: (database) => {
    database.exec(DRAFTS_TABLE);
  },
  3: (database) => {
    database.exec(`${FAILURE_SIGNATURES_TABLE}
${ESCALATIONS_TABLE}
${USAGE_LINES_TABLE}
ALTER TABLE attempts ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE attempts ADD COLUMN dispatched TEXT;
${RETRY_INDEX}`);
  },
  4: (database) => {
    database.exec("ALTER TABLE runs ADD COLUMN discarded_at TEXT;");
  },
  5: (database) => {
    database.exec(APPROVALS_TABLE);
  },
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToken = (value) => typeof value === "string" && value !== "";

// Opens the store for one host repo. `clock` is injected so timestamps and
// lease expiry are deterministic under test; production uses wall time.
// `eventLedgerLimit` bounds each run's retained event suffix (the default is
// the module constant); trimming is what makes an old cursor honestly expired.
export const openClarificationStore = ({
  hostRepo,
  databasePath,
  eventLedgerLimit = EVENT_LEDGER_LIMIT,
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

  // Idempotent: on an older file the IF NOT EXISTS leaves the existing
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

  // The one-coordinator-retry index references the origin column, so it can
  // only exist once that column does — after the migrations, on every open.
  // Idempotent, like the schema above it.
  database.exec(RETRY_INDEX);

  const insertRun = database.prepare(
    "INSERT INTO runs (run_id, host_repo, issue_id, request_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertAttempt = database.prepare(
    "INSERT INTO attempts (attempt_id, run_id, host_repo, request_id, dispatch_intent, state, created_at, updated_at, result, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
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

  const attemptRow = (row) => {
    if (row === undefined) return null;
    const dispatched =
      row.dispatched === null || row.dispatched === undefined ? null : JSON.parse(row.dispatched);
    return {
      attemptId: row.attempt_id,
      runId: row.run_id,
      hostRepo: row.host_repo,
      requestId: row.request_id,
      dispatchIntent: JSON.parse(row.dispatch_intent),
      state: row.state,
      result: row.result === null || row.result === undefined ? null : JSON.parse(row.result),
      origin: row.origin ?? "manual",
      ...(dispatched === null ? {} : { dispatchedAt: dispatched.at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  const draftRow = (row) =>
    row === undefined
      ? null
      : {
          attemptId: row.attempt_id,
          runId: row.run_id,
          hostRepo: row.host_repo,
          draft: JSON.parse(row.draft),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };

  const draftSelect = "SELECT * FROM drafts WHERE attempt_id = ? AND host_repo = ?";
  const getDraftInTx = (attemptId) =>
    draftRow(database.prepare(draftSelect).get(attemptId, hostRepo));

  const approvalRow = (row) =>
    row === undefined
      ? null
      : {
          nonce: row.nonce,
          attemptId: row.attempt_id,
          runId: row.run_id,
          hostRepo: row.host_repo,
          binding: JSON.parse(row.binding),
          status: row.status,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          ...(row.consumed_at === null || row.consumed_at === undefined
            ? {}
            : { consumedAt: row.consumed_at }),
        };

  // Reads and writes always carry the host repo: a run from another repo is
  // invisible here, indistinguishable from one that does not exist.
  const ownRun = (runId) =>
    database.prepare("SELECT * FROM runs WHERE run_id = ? AND host_repo = ?").get(runId, hostRepo);

  const ownAttempt = (attemptId) =>
    database
      .prepare("SELECT * FROM attempts WHERE attempt_id = ? AND host_repo = ?")
      .get(attemptId, hostRepo);

  const ownApproval = (nonce) =>
    database
      .prepare("SELECT * FROM approvals WHERE nonce = ? AND host_repo = ?")
      .get(nonce, hostRepo);

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
  // transition). A lost race re-reads and reports against reality. The
  // lease gate and the write share one immediate transaction — the write
  // lock spans both, so no other writer can slip a newer lease generation
  // between the fence check and the row update.
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

  // Append inside an open transaction: the per-run cursor is the ledger's
  // own, allocation and insert commit atomically with the caller's write,
  // and the bound trims the oldest rows — which is what makes an old cursor
  // honestly expired rather than silently rewritten. A fenced annotation is
  // stored as the operational event it is — the same typed-event vocabulary
  // the observation stream carries, so the ledger holds one history. The
  // verbatim form appends a ready-made event object (the lifecycle moves
  // some store-level transitions must carry, like a resolved-terminal
  // attempt ending its stream) under the same durability.
  const appendEventObjectInTx = ({ runId, event, at }) => {
    const cursor =
      (database
        .prepare("SELECT MAX(seq) AS max_seq FROM events WHERE run_id = ? AND host_repo = ?")
        .get(runId, hostRepo)?.max_seq ?? 0) + 1;
    database
      .prepare(
        "INSERT INTO events (host_repo, run_id, seq, event, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(hostRepo, runId, cursor, JSON.stringify(event), at);
    database
      .prepare("DELETE FROM events WHERE host_repo = ? AND run_id = ? AND seq <= ?")
      .run(hostRepo, runId, cursor - eventLedgerLimit);
    return { cursor, envelope: EVENT_ENVELOPE_VERSION, event };
  };

  const appendEventInTx = ({ runId, kind, data, at }) =>
    appendEventObjectInTx({ runId, event: { type: "operational", kind, data, at }, at });

  // The lease-free half of the fence: reconciliation moves through a
  // compare-and-set transition and leaves its evidence in the ledger, in
  // the same commit. It records Workbench's inspection of its own records —
  // it claims no external effect, so it needs no live lease. It can only
  // conclude terminal by citing the evidence basis it inspected (ticket
  // #236): a basis-free terminal conclusion is the false completion ADR
  // 0020 forbids, and an attempt resolved to terminal carries its lifecycle
  // terminal event in the same commit — the stream's only end, never
  // published before it is durable.
  const reconcile = ({ table, idColumn, what, notFoundCode, rowMapper, kindPrefix, idField }) => {
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
          appendEventInTx({
            runId: table === "runs" ? id : current.run_id,
            kind: `${kindPrefix}.reconciliation.started`,
            data: { [idField]: id, from: row.state },
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
          appendEventInTx({
            runId: table === "runs" ? id : current.run_id,
            kind: `${kindPrefix}.reconciliation.resolved`,
            data: basis === undefined ? { [idField]: id, to } : { [idField]: id, to, basis },
            at,
          });
          // The attempt's terminal classification is the one stream-ending
          // fact, so it lands as the lifecycle event the streams watch —
          // committed here, before any viewer can be served it.
          if (table === "attempts" && to === "terminal")
            appendEventObjectInTx({
              runId: current.run_id,
              event: { type: "lifecycle", scope: "attempt", id, state: "terminal", at },
              at,
            });
          return rowMapper(database.prepare(select).get(id, hostRepo));
        });
      },
    };
  };

  const runReconciliation = reconcile({
    table: "runs",
    idColumn: "run_id",
    what: "run",
    notFoundCode: "run_not_found",
    rowMapper: runRow,
    kindPrefix: "run",
    idField: "runId",
  });
  const attemptReconciliation = reconcile({
    table: "attempts",
    idColumn: "attempt_id",
    what: "attempt",
    notFoundCode: "attempt_not_found",
    rowMapper: attemptRow,
    kindPrefix: "attempt",
    idField: "attemptId",
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
    createAttempt({ runId, requestId, intent: dispatchIntent, leaseToken, origin = "manual" }) {
      if (requestId === undefined || typeof requestId !== "string" || requestId.trim() === "")
        throw storeError("invalid_request", "an attempt needs a non-empty request id");
      if (!isPlainObject(dispatchIntent))
        throw storeError("invalid_request", "an attempt carries a dispatch intent object");
      if (!ATTEMPT_ORIGINS.includes(origin))
        throw storeError("invalid_request", `"${String(origin)}" is not an attempt origin`);
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
            attempt.createdAt,
            attempt.updatedAt,
            attempt.origin,
          );
        } catch (error) {
          // A UNIQUE failure is either the (run_id, request_id) dedup — in
          // which case the replayed attempt is the answer — or the one-
          // coordinator-retry index, whose spent refusal is typed. Which one
          // it was is read off reality, not off a constraint-name string.
          if (!/UNIQUE constraint failed/.test(String(error?.message))) throw error;
          const winner = database
            .prepare("SELECT * FROM attempts WHERE run_id = ? AND request_id = ? AND host_repo = ?")
            .get(runId, requestId, hostRepo);
          if (winner !== undefined) return { attempt: attemptRow(winner), created: false };
          throw storeError(
            "coordinator_retry_spent",
            `run "${runId}" has already used its one coordinator retry`,
          );
        }
        return { attempt, created: true };
      });
    },

    getAttempt(attemptId) {
      return attemptRow(ownAttempt(attemptId));
    },

    // The Clarification draft (ticket #233): the attempt's proposal as one
    // mutable document, latest write wins. Saving a draft claims no effect
    // on the world — it records the proposal itself — but it is a write on
    // the run's record, so it travels under the live controller lease like
    // every mutation; the document's shape is the draft module's contract,
    // validated before it reaches the store. The draft's run comes from the
    // attempt row, never from the caller.
    saveDraft({ attemptId, draft, leaseToken }) {
      if (!isPlainObject(draft))
        throw storeError("invalid_request", "a Clarification draft is an object");
      return tx(() => {
        const attempt = ownAttempt(attemptId);
        if (attempt === undefined)
          throw storeError(
            "attempt_not_found",
            `no attempt "${attemptId}" is visible to this host repo`,
          );
        requireLiveLease(attempt.run_id, leaseToken);
        const now = clock();
        database
          .prepare(
            "INSERT INTO drafts (attempt_id, run_id, host_repo, draft, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET draft = excluded.draft, updated_at = excluded.updated_at",
          )
          .run(attemptId, attempt.run_id, hostRepo, JSON.stringify(draft), now, now);
        return getDraftInTx(attemptId);
      });
    },

    // The draft read is open like every read: an attempt without a draft,
    // and an attempt from another repo, are the same honest null.
    getDraft(attemptId) {
      return getDraftInTx(attemptId);
    },

    // The approval binding's durable record (ticket #234): the Developer's
    // explicit approval of one exact issue-body publication, committed
    // BEFORE anything is written to the tracker — a crash after this point
    // leaves the approval inspectable, never the write unproven and
    // unrecorded. The binding's shape is the approval module's contract,
    // validated before it reaches the store; the nonce is minted here, the
    // only spendable identity of this approval. Fenced like every mutation,
    // and only an active attempt approves anything.
    recordApproval({ attemptId, binding, ttlMs = DEFAULT_APPROVAL_TTL_MS, leaseToken }) {
      if (!isPlainObject(binding))
        throw storeError("invalid_request", "an approval carries its binding object");
      if (!Number.isInteger(ttlMs) || ttlMs <= 0)
        throw storeError("invalid_request", "an approval needs a positive ttl in milliseconds");
      return tx(() => {
        const attempt = ownAttempt(attemptId);
        if (attempt === undefined)
          throw storeError(
            "attempt_not_found",
            `no attempt "${attemptId}" is visible to this host repo`,
          );
        requireLiveLease(attempt.run_id, leaseToken);
        if (attempt.state !== "active")
          throw storeError(
            "attempt_not_active",
            `attempt "${attemptId}" is ${attempt.state} — only an active attempt approves a publication`,
          );
        const now = clock();
        const approval = {
          nonce: `approval_${randomUUID()}`,
          attemptId,
          runId: attempt.run_id,
          hostRepo,
          binding,
          status: "pending",
          expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
          createdAt: now,
        };
        database
          .prepare(
            "INSERT INTO approvals (nonce, attempt_id, run_id, host_repo, binding, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            approval.nonce,
            approval.attemptId,
            approval.runId,
            approval.hostRepo,
            JSON.stringify(approval.binding),
            approval.status,
            approval.expiresAt,
            approval.createdAt,
          );
        return { approval };
      });
    },

    // Open reads: an approval, and an attempt's newest one. Evidence, like
    // every read — the token is never in the row to begin with.
    getApproval(nonce) {
      if (typeof nonce !== "string" || nonce === "")
        throw storeError("invalid_request", "an approval is named by its nonce");
      return approvalRow(
        database
          .prepare("SELECT * FROM approvals WHERE nonce = ? AND host_repo = ?")
          .get(nonce, hostRepo),
      );
    },

    latestApproval(attemptId) {
      return approvalRow(
        database
          .prepare(
            "SELECT * FROM approvals WHERE attempt_id = ? AND host_repo = ? ORDER BY rowid DESC LIMIT 1",
          )
          .get(attemptId, hostRepo),
      );
    },

    // The single-use consumption: a compare-and-set from pending, under the
    // live lease, in one transaction. The expiry is checked here like the
    // lease's — arithmetic against the clock — so an approval cannot be
    // spent a moment after its death by a caller that skipped the gate. A
    // raced or dead approval is a typed refusal; the write that would have
    // ridden it must never happen.
    consumeApproval({ nonce, leaseToken }) {
      return tx(() => {
        const row = ownApproval(nonce);
        if (row === undefined)
          throw storeError("approval_not_found", `no approval is visible to this host repo`);
        requireLiveLease(row.run_id, leaseToken);
        if (Date.parse(row.expires_at) <= Date.parse(clock()))
          throw storeError(
            "approval_expired",
            `the approval expired at ${row.expires_at} — approve the current diff again`,
          );
        const updated = database
          .prepare(
            "UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE nonce = ? AND host_repo = ? AND status = 'pending'",
          )
          .run(clock(), nonce, hostRepo);
        if (updated.changes === 0) {
          const reality = ownApproval(nonce);
          throw storeError(
            reality?.status === "stale" ? "approval_stale" : "approval_already_used",
            reality?.status === "stale"
              ? "this approval went stale and can never publish"
              : "this approval is single-use and has already been spent",
          );
        }
        return approvalRow(ownApproval(nonce));
      });
    },

    // The gate's refusal, made durable: a pending approval the pre-write
    // check found stale is marked stale, and is then dead forever — not
    // re-judged at every future gate, but visibly, structurally spent.
    markApprovalStale({ nonce, leaseToken }) {
      return tx(() => {
        const row = ownApproval(nonce);
        if (row === undefined)
          throw storeError("approval_not_found", `no approval is visible to this host repo`);
        requireLiveLease(row.run_id, leaseToken);
        const updated = database
          .prepare(
            "UPDATE approvals SET status = 'stale' WHERE nonce = ? AND host_repo = ? AND status = 'pending'",
          )
          .run(nonce, hostRepo);
        if (updated.changes === 0) {
          const reality = ownApproval(nonce);
          throw storeError(
            reality?.status === "consumed" ? "approval_already_used" : "approval_stale",
            `this approval is already ${reality?.status ?? "not pending"}`,
          );
        }
        return approvalRow(ownApproval(nonce));
      });
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

    // The failure policy's one atomic write (ticket #235, ADR 0023): the
    // outcome result, the lifecycle move it drives, and the operational
    // event that carries it to viewers commit as one transaction — evidence
    // and record can never disagree, and an illegal transition writes
    // nothing at all. Fenced like every mutation.
    recordAttemptOutcome({ attemptId, to, result, event, leaseToken }) {
      if (!isPlainObject(result) || typeof result.kind !== "string" || result.kind.trim() === "")
        throw storeError("invalid_request", "an attempt outcome carries a non-empty kind");
      if (!isPlainObject(event) || typeof event.kind !== "string" || event.kind.trim() === "")
        throw storeError("invalid_request", "an attempt outcome carries an operational event");
      if (!isPlainObject(event.data))
        throw storeError("invalid_request", "an operational event carries a data object");
      return tx(() => {
        const row = ownAttempt(attemptId);
        if (row === undefined)
          throw storeError(
            "attempt_not_found",
            `no attempt "${attemptId}" is visible to this host repo`,
          );
        requireLiveLease(row.run_id, leaseToken);
        applyTransition({ current: row.state, to, what: "attempt" });
        const now = clock();
        const updated = database
          .prepare(
            "UPDATE attempts SET result = ?, state = ?, updated_at = ? WHERE attempt_id = ? AND host_repo = ? AND state = ?",
          )
          .run(JSON.stringify(result), to, now, attemptId, hostRepo, row.state);
        if (updated.changes === 0) {
          const reality = ownAttempt(attemptId);
          throw storeError(
            "illegal_transition",
            `an attempt in state "${reality?.state ?? "???"}" cannot move to "${to}" — another writer moved it first`,
          );
        }
        appendEventInTx({ runId: row.run_id, kind: event.kind, data: event.data, at: now });
        return attemptRow(ownAttempt(attemptId));
      });
    },

    // The dispatch mark: durable evidence that the managed runtime became
    // ready and the dispatch window opened on this attempt. It lands once,
    // on an active attempt, in the same commit as its operational event —
    // after this, "no dispatch occurred" can never be proven again.
    markAttemptDispatched({ attemptId, evidence, leaseToken } = {}) {
      if (evidence !== undefined && evidence !== null && !isPlainObject(evidence))
        throw storeError("invalid_request", "dispatch evidence travels verbatim as an object");
      return tx(() => {
        const row = ownAttempt(attemptId);
        if (row === undefined)
          throw storeError(
            "attempt_not_found",
            `no attempt "${attemptId}" is visible to this host repo`,
          );
        requireLiveLease(row.run_id, leaseToken);
        if (row.state !== "active")
          throw storeError(
            "dispatch_not_markable",
            `attempt "${attemptId}" is ${row.state} — a dispatch mark records a live attempt's evidence`,
          );
        if (row.dispatched !== null && row.dispatched !== undefined)
          throw storeError(
            "dispatch_marked",
            `attempt "${attemptId}" already carries a dispatch mark`,
          );
        const now = clock();
        database
          .prepare(
            "UPDATE attempts SET dispatched = ?, updated_at = ? WHERE attempt_id = ? AND host_repo = ? AND dispatched IS NULL",
          )
          .run(JSON.stringify({ at: now, evidence: evidence ?? null }), now, attemptId, hostRepo);
        appendEventInTx({
          runId: row.run_id,
          kind: "attempt.dispatched",
          data: { attemptId },
          at: now,
        });
        return attemptRow(ownAttempt(attemptId));
      });
    },

    // The no-progress detector's durable counter: one row per (run,
    // signature), counting the attempts that failed identically. Reads back
    // across restarts, so a loop cannot hide by spanning them. The counted
    // attempt must belong to THIS run — another run's attempt must never
    // inflate this run's loop counter.
    recordFailureSignature({ runId, signature, attemptId, leaseToken }) {
      if (typeof signature !== "string" || signature === "")
        throw storeError("invalid_request", "a failure signature is a non-empty string");
      return tx(() => {
        if (ownRun(runId) === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        requireLiveLease(runId, leaseToken);
        if (ownAttempt(attemptId)?.run_id !== runId)
          throw storeError(
            "attempt_not_found",
            `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
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
      });
    },

    // The no-progress halt, atomic and fenced: the escalation record inserts
    // (its (run, signature) key is unique, so one signature escalates once —
    // a repeat is a typed already_halted), the escalation event lands in the
    // ledger, and an active run moves to awaiting-human. A run already
    // parked or beyond that still records the handoff — the park is
    // idempotent, the record is not lost.
    haltRun({ runId, record, leaseToken }) {
      if (!isPlainObject(record))
        throw storeError("invalid_request", "an escalation record is an object");
      for (const field of ["signature", "attemptId", "at"])
        if (typeof record[field] !== "string" || record[field] === "")
          throw storeError("invalid_request", `an escalation record needs a ${field}`);
      if ("type" in record || "scope" in record || "id" in record)
        throw storeError(
          "invalid_request",
          "an escalation record carries its identity from the run — no type, scope, or id fields",
        );
      return tx(() => {
        if (ownRun(runId) === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        requireLiveLease(runId, leaseToken);
        try {
          database
            .prepare(
              "INSERT INTO escalations (host_repo, run_id, signature, record, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(hostRepo, runId, record.signature, JSON.stringify(record), clock());
        } catch (error) {
          if (/UNIQUE constraint failed/.test(String(error?.message)))
            throw storeError(
              "already_halted",
              `run "${runId}" already escalated signature "${record.signature}"`,
            );
          throw error;
        }
        // The event carries the record's fields; the run's identity rides
        // the operational kind and the ledger's run scope, so it is not
        // duplicated inside.
        const { runId: _recordRunId, ...recordFields } = record;
        appendEventInTx({ runId, kind: "run.halted", data: recordFields, at: clock() });
        // Only an active run is parked; the compare-and-set keeps the write
        // on the legal transition alone.
        const moved =
          database
            .prepare(
              "UPDATE runs SET state = 'awaiting-human', updated_at = ? WHERE run_id = ? AND host_repo = ? AND state = 'active'",
            )
            .run(clock(), runId, hostRepo).changes === 1;
        return { record, moved };
      });
    },

    // The durable usage budget: lines appended to the run's envelope, each
    // carrying its own kind — reported, estimated, unknown — and never
    // converted. Shapes are checked here so bad data never lands; the
    // closed kind vocabulary is the policy layer's to enforce.
    appendUsageLines({ runId, lines, leaseToken }) {
      if (!Array.isArray(lines) || lines.length === 0)
        throw storeError("invalid_request", "a usage append carries at least one line");
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
        return { ...line };
      });
      return tx(() => {
        if (ownRun(runId) === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        requireLiveLease(runId, leaseToken);
        const now = clock();
        return prepared.map((line) => {
          if (
            line.attemptId !== undefined &&
            line.attemptId !== null &&
            ownAttempt(line.attemptId)?.run_id !== runId
          )
            throw storeError(
              "attempt_not_found",
              `no attempt "${line.attemptId}" is visible on run "${runId}" in this host repo`,
            );
          const lineId = `usage_${randomUUID()}`;
          const value = typeof line.value === "number" ? line.value : null;
          database
            .prepare(
              "INSERT INTO usage_lines (host_repo, run_id, line_id, attempt_id, kind, unit, value, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              hostRepo,
              runId,
              lineId,
              line.attemptId ?? null,
              line.kind,
              line.unit,
              value,
              line.detail === undefined || line.detail === null
                ? null
                : JSON.stringify(line.detail),
              now,
            );
          return {
            lineId,
            ...(line.attemptId === undefined || line.attemptId === null
              ? {}
              : { attemptId: line.attemptId }),
            kind: line.kind,
            unit: line.unit,
            value,
            ...(line.detail === undefined || line.detail === null ? {} : { detail: line.detail }),
            createdAt: now,
          };
        });
      });
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

    // Reconciliation, run level: lease-free by design (see the module head).
    beginReconciliation({ runId }) {
      return runReconciliation.begin(runId);
    },

    resolveReconciliation({ runId, to, basis }) {
      return runReconciliation.resolve(runId, to, { basis });
    },

    // Reconciliation, attempt level: the lease-free way out of a stuck
    // unknown.
    beginAttemptReconciliation({ attemptId }) {
      return attemptReconciliation.begin(attemptId);
    },

    resolveAttemptReconciliation({ attemptId, to, basis }) {
      return attemptReconciliation.resolve(attemptId, to, { basis });
    },

    // Process death, recorded (ticket #236): one transaction lands the
    // attempt and the run in `unknown` with the termination evidence on the
    // attempt and the operational event in the ledger. It is lease-free on
    // purpose — a deliberate reading of ADR 0020's "every mutating
    // operation requires a controller lease", flagged for the ADR's owner:
    // it records the LOSS of proof, claims no effect, and must be writable
    // exactly when the lease is gone (the holder is what died). The
    // evidence separates what is proven (the runtime's observed exit, when
    // it was observed) from what stays uncertain at this tier: the fate of
    // the runtime's descendant processes, and the exit itself when it went
    // unobserved. Proving a descendant kill is the caller's to record,
    // through the fenced result write, when it truly has that proof. An
    // already-recorded result is kept, never rewritten (COALESCE); a second
    // death report, an unknown attempt, or an attempt of another run is a
    // typed rejection.
    recordProcessDeath({ runId, attemptId, exit }) {
      if (exit !== null && typeof exit !== "number")
        throw storeError(
          "invalid_request",
          "a process death carries the observed exit status, or null when it was not observed",
        );
      const at = clock();
      const evidence = {
        proof: exit === null ? {} : { runtimeExit: exit },
        uncertainty:
          exit === null ? ["runtime-exit", "descendant-termination"] : ["descendant-termination"],
      };
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
            JSON.stringify({ kind: "termination", at, ...evidence }),
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
        appendEventInTx({
          runId,
          kind: "attempt.process-death",
          data: { attemptId, runId, exit, ...evidence },
          at,
        });
        return { run: runRow(ownRun(runId)), attempt: attemptRow(ownAttempt(attemptId)) };
      });
    },

    // The typed destructive discard (ticket #236): the one path that
    // deletes retained evidence. The confirmation echoes the run id — the
    // caller names what it destroys — and the whole discard is one commit:
    // the run closes terminal with the discard stamped on it, and the
    // ledger is purged with it, so evidence cannot half-vanish. Lease-free
    // like reconciliation — a quarantined record's controller is exactly
    // what may no longer exist, and requiring a live lease would make an
    // orphaned record undeletable forever; the typed confirmation is the
    // authority. Awaiting-human counts as discardable on purpose: parked
    // for a human decision includes the decision to discard. The attempt
    // rows survive as records; the event evidence does not.
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

    // The operational event ledger, fenced half. The annotation is stored
    // as the operational event it is and committed — durably, WAL with
    // synchronous FULL — before this returns, so the coordinator can never
    // publish what the store has not already persisted.
    appendEvent({ runId, kind, data, leaseToken }) {
      if (typeof kind !== "string" || kind.trim() === "")
        throw storeError("invalid_request", "an operational event carries a non-empty kind");
      if (!isPlainObject(data))
        throw storeError("invalid_request", "an operational event carries a data object");
      return tx(() => {
        if (ownRun(runId) === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        requireLiveLease(runId, leaseToken);
        return appendEventInTx({ runId, kind, data, at: clock() });
      });
    },

    // Reconnect read: the events after the viewer's cursor, ascending, as
    // ledger envelopes. A cursor that predates the retained suffix reports
    // the explicit gap — the events in between are gone, and nothing is
    // invented to fill them. A cursor past the ledger's end claims history
    // the store never wrote and is refused.
    readEvents({ runId, afterCursor }) {
      if (!Number.isInteger(afterCursor) || afterCursor < 0)
        throw storeError(
          "invalid_request",
          "an operational event cursor is a non-negative integer",
        );
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

    // The reconnect baseline: one snapshot per run, latest write wins, the
    // write fenced like every mutation, the read open — a reconnecting
    // viewer must never need a lease to catch up.
    saveSnapshot({ runId, snapshot, leaseToken }) {
      if (!isPlainObject(snapshot)) throw storeError("invalid_request", "a snapshot is an object");
      return tx(() => {
        if (ownRun(runId) === undefined)
          throw storeError("run_not_found", `no run "${runId}" is visible to this host repo`);
        requireLiveLease(runId, leaseToken);
        const savedAt = clock();
        database
          .prepare(
            "INSERT INTO run_snapshots (run_id, host_repo, snapshot, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET snapshot = excluded.snapshot, saved_at = excluded.saved_at",
          )
          .run(runId, hostRepo, JSON.stringify(snapshot), savedAt);
        return { savedAt };
      });
    },

    getSnapshot(runId) {
      const row = database
        .prepare("SELECT * FROM run_snapshots WHERE run_id = ? AND host_repo = ?")
        .get(runId, hostRepo);
      return row === undefined
        ? null
        : { snapshot: JSON.parse(row.snapshot), savedAt: row.saved_at };
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
            .run(hostRepo, runId, cursor, JSON.stringify(event), now);
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
        database.exec("COMMIT");
        return persisted;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
};
