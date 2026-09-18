// The clarification coordinator (spec #221, tickets #230+, ADR 0015): the
// one new seam between the dashboard's clarification routes and everything
// durable. Typed commands in — the pre-start manifest, the explicit start,
// the run section read — typed results and typed rejections out. Its ports
// are injected: the durable run-record store, the tracker context read,
// the managed Pi session starter, and the clock. Tests substitute all of
// them; nothing here touches real SQLite, the tracker, or a runtime.
//
// The pre-start manifest is display projection over a fresh collected
// issue read plus the install's declared provider and data destination —
// the fixed facts the Developer approves before any start exists, always
// closing with the no-publishing line. The explicit start travels only
// after the manifest's pinned issue revision still matches a fresh read:
// a material change is a typed rejection and a re-rendered manifest, never
// a start on evidence the Developer did not see.

import { noPublishingLine } from "../../../src/types.ts";

// The manifest's fixed lines (ADR 0016's read/research-only posture, ADR
// 0023's honest accounting): capability summary, egress statement, budget
// line — constants, not configuration, so the display contract cannot
// drift with a config edit.
const CAPABILITY_SUMMARY = Object.freeze([
  "reads the pinned issue and its related planning records",
  "reads the host repository's declared context",
  "reads approved public research destinations",
]);

const EGRESS_STATEMENT =
  "research retrieval goes only to approved public destinations; " +
  "private repository and issue content never enters public queries";

const BUDGET_LINE =
  "provider-reported usage is recorded verbatim; estimates and unknown " +
  "subscription availability stay labeled and never silently convert";

export { noPublishingLine };

export const clarificationError = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code, ...extra });

// The coordinator is the run records' controller: the lease it presents on
// every fenced mutation is its own, named so a human reading the record
// knows who held it.
export const LEASE_OWNER = "workbench-clarification-coordinator";

// The display projection of a durable run row: the run section's facts,
// never the lease token or the raw dispatch intent.
const projectRun = (run) => ({
  runId: run.runId,
  issueId: run.issueId,
  state: run.state,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
});

const projectAttempt = (attempt) => ({
  attemptId: attempt.attemptId,
  state: attempt.state,
  createdAt: attempt.createdAt,
  updatedAt: attempt.updatedAt,
});

const validateStart = ({ issueNumber, requestId, revision }) => {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0)
    throw clarificationError(
      "invalid_request",
      "a clarification start names a positive issue number",
    );
  if (typeof requestId !== "string" || requestId.trim() === "")
    throw clarificationError(
      "invalid_request",
      "a clarification start carries a non-empty request id",
    );
  if (!revision || typeof revision.updatedAt !== "string" || typeof revision.bodyHash !== "string")
    throw clarificationError(
      "invalid_request",
      "a clarification start presents the manifest's pinned issue revision",
    );
};

// The manifest gate: the presented revision — what the Developer saw and
// approved — must still be the tracker's truth, both stamps of it. Any
// drift is a typed stale rejection and a re-rendered manifest, never a
// start on evidence the Developer did not see.
const revisionMatches = (presented, fresh) =>
  presented.updatedAt === fresh.updatedAt && presented.bodyHash === fresh.bodyHash;

export const createClarificationCoordinator = ({
  store,
  tracker,
  sessions,
  clock,
  provider,
  dataDestination,
}) => {
  if (!store || typeof store.createRun !== "function")
    throw clarificationError("invalid_coordinator", "the coordinator needs a durable store port");
  if (!tracker || typeof tracker.readContext !== "function")
    throw clarificationError("invalid_coordinator", "the coordinator needs a tracker read port");
  if (!sessions || typeof sessions.start !== "function")
    throw clarificationError("invalid_coordinator", "the coordinator needs a managed session port");
  if (typeof clock !== "function")
    throw clarificationError("invalid_coordinator", "the coordinator needs a clock");

  // The collected issue read the manifest and the start both fail closed
  // on: without the issue and its pinned revision there is no manifest to
  // approve and nothing to start — readiness is withheld, not guessed.
  const collectedFor = async (issueNumber) => {
    const collected = await tracker.readContext({ issueNumber });
    if (!collected || collected.failed || !collected.issue || !collected.revision)
      throw clarificationError(
        "context_unavailable",
        `the tracker context for issue ${issueNumber} is incomplete — the manifest and start withhold rather than guess`,
      );
    return collected;
  };

  // One start at a time per issue, in process: racing submissions
  // serialize here, and the loser answers from the record the winner
  // wrote — a typed busy rejection, never a silent queue. (The dev server
  // is the single writer process for a host repo's records, ADR 0020; the
  // store's request-id uniqueness stays as the durable backstop.)
  const inFlightStarts = new Map();
  const serializedFor = (issueId, fn) => {
    const previous = inFlightStarts.get(issueId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    inFlightStarts.set(
      issueId,
      next.catch(() => {}),
    );
    return next;
  };

  return {
    // The fixed pre-start manifest for one issue: what starting grants,
    // rendered from the fresh collected read and the install's declared
    // provider and data destination, ending with the no-publishing line.
    async manifest({ issueNumber }) {
      const collected = await collectedFor(issueNumber);
      return {
        issue: {
          number: collected.issue.number,
          title: collected.issue.title,
          revision: {
            updatedAt: collected.revision.updatedAt,
            bodyHash: collected.revision.bodyHash,
          },
        },
        provider,
        dataDestination,
        capabilitySummary: [...CAPABILITY_SUMMARY],
        egressStatement: EGRESS_STATEMENT,
        budgetLine: BUDGET_LINE,
        noPublishingLine,
      };
    },

    // The explicit start on the visible manifest: one durable run record,
    // one durable first attempt, the controller lease — and only then the
    // one side effect, the managed session dispatch through its port. The
    // client request id deduplicates across reconnects: a replayed request
    // is answered from the durable record, never a second attempt.
    async start({ issueNumber, requestId, revision }) {
      validateStart({ issueNumber, requestId, revision });
      const issueId = String(issueNumber);
      return serializedFor(issueId, async () => {
        const runs = store.listRuns();
        const own = runs.find((r) => r.issueId === issueId && r.requestId === requestId);
        if (own) {
          const attempt = store.listAttempts(own.runId).find((a) => a.requestId === requestId);
          if (attempt)
            return { started: false, run: projectRun(own), attempt: projectAttempt(attempt) };
        } else if (runs.some((r) => r.issueId === issueId && r.state !== "terminal")) {
          throw clarificationError(
            "busy",
            `issue ${issueNumber} already has a clarification run in flight — one run per approved intent`,
          );
        }

        // The manifest gate: the start travels only on the revision the
        // Developer saw. A drifted issue re-renders the manifest first.
        const collected = await collectedFor(issueNumber);
        if (!revisionMatches(revision, collected.revision))
          throw clarificationError(
            "manifest_stale",
            `issue ${issueNumber} moved past the revision the manifest showed — a fresh manifest is required before starting`,
          );

        const { run, created } = store.createRun({ issueId, requestId });
        let lease;
        try {
          lease = store.acquireLease({ runId: run.runId, owner: LEASE_OWNER });
        } catch (error) {
          if (error?.code === "lease_held")
            throw clarificationError(
              "busy",
              `the controller lease for run "${run.runId}" is held elsewhere — the start is refused, never queued`,
            );
          throw error;
        }
        const token = lease.lease.token;
        if (created)
          store.appendEvent({
            runId: run.runId,
            kind: "run.started",
            data: { issueId, requestId },
            leaseToken: token,
          });

        // The durable dispatch intent: the attempt commits before any side
        // effect, carrying what the manifest showed and the Developer
        // approved — the issue, its pinned revision, the declared provider
        // and data destination.
        const { attempt, created: attemptCreated } = store.createAttempt({
          runId: run.runId,
          requestId,
          intent: { kind: "clarification-start", issueNumber, revision, provider, dataDestination },
          leaseToken: token,
        });
        if (!attemptCreated)
          return { started: false, run: projectRun(run), attempt: projectAttempt(attempt) };
        store.appendEvent({
          runId: run.runId,
          kind: "attempt.recorded",
          data: { attemptId: attempt.attemptId, issueNumber, revision },
          leaseToken: token,
        });

        // The one side effect, behind durable intent: the managed session
        // dispatch. A denial here is known failure evidence, recorded under
        // the live lease — the attempt closes terminal, the run parks
        // awaiting-human, and the Developer's decision is the only next
        // move. A fencing refusal while recording that evidence surfaces
        // typed: a stale writer records nothing quietly.
        try {
          await sessions.start({ runId: run.runId, attemptId: attempt.attemptId, issueNumber });
        } catch (error) {
          const code = error?.code ?? "unknown";
          store.recordAttemptResult({
            attemptId: attempt.attemptId,
            result: { kind: "start-denied", code, message: String(error?.message ?? error) },
            leaseToken: token,
          });
          store.appendEvent({
            runId: run.runId,
            kind: "attempt.start-denied",
            data: { attemptId: attempt.attemptId, code },
            leaseToken: token,
          });
          store.updateAttemptState({
            attemptId: attempt.attemptId,
            to: "terminal",
            leaseToken: token,
          });
          store.updateRunState({ runId: run.runId, to: "awaiting-human", leaseToken: token });
          throw clarificationError(
            "start_denied",
            `the managed session for issue ${issueNumber} was denied before it could start: ${
              error?.message ?? error
            }`,
            { runId: run.runId, attemptId: attempt.attemptId },
          );
        }
        return { started: true, run: projectRun(run), attempt: projectAttempt(attempt) };
      });
    },

    // The run section's read: lifecycle, attempts, the reconnect snapshot
    // baseline, and the operational events after the viewer's cursor — all
    // from the durable record, all open (no lease), with an expired
    // cursor's gap traveling through untouched so the timeline never
    // invents the history it cannot prove.
    async runSection({ runId, afterCursor = 0 }) {
      if (typeof runId !== "string" || runId === "")
        throw clarificationError("invalid_request", "a run section read names a run id");
      if (!Number.isInteger(afterCursor) || afterCursor < 0)
        throw clarificationError(
          "invalid_request",
          "an operational event cursor is a non-negative integer",
        );
      const run = store.getRun(runId);
      if (!run)
        throw clarificationError(
          "run_not_found",
          `no clarification run "${runId}" is visible to this host repo`,
        );
      const attempts = store.listAttempts(runId);
      const snapshot = store.getSnapshot(runId);
      const ledger = store.getEvents({ runId, afterCursor });
      return {
        run: projectRun(run),
        attempts: attempts.map(projectAttempt),
        ...(snapshot ? { snapshot: snapshot.snapshot, snapshotSavedAt: snapshot.savedAt } : {}),
        events: ledger.events,
        ...(ledger.gap ? { gap: ledger.gap } : {}),
      };
    },
  };
};
