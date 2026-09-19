// The clarification coordinator (spec #221, tickets #230 + #231, ADRs 0015 +
// 0020): the one new seam between the dashboard's clarification routes and
// everything durable. Typed commands in — the pre-start manifest, the
// explicit start, the run section read — typed results and typed rejections
// out, plus the observation half: every event an attempt produces is
// published into the durable operational event ledger FIRST and only then
// fanned out to attached viewers, so what a live viewer sees is always
// already evidence, and a returning viewer is served from the same ledger
// with the same cursors.
//
// Its ports are injected: the durable run-record store, the tracker context
// read, the managed Pi session starter, and the clock. Tests substitute all
// of them; nothing here touches real SQLite, the tracker, or a runtime.
//
// The pre-start manifest is display projection over a fresh collected issue
// read plus the install's declared provider and data destination — the
// fixed facts the Developer approves before any start exists, always
// closing with the no-publishing line. The explicit start travels only
// after the manifest's pinned issue revision still matches a fresh read:
// a material change is a typed rejection and a re-rendered manifest, never
// a start on evidence the Developer did not see.
//
// Viewers are observers and nothing else (ADR 0020): attaching, detaching,
// and losing a viewer never mutates the attempt. Cancellation is an
// explicit, confirmed command — never a side effect of a browser going
// away. The ledger itself is the coordination state: publishing wakes the
// waiters, each viewer then reads its own delta from the store, so there is
// no second, in-memory copy of history that could disagree with the durable
// record.

import { noPublishingLine } from "../../../src/types.ts";
import { EVENT_ENVELOPE_VERSION } from "./store.mjs";

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

export const clarificationError = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code, ...extra });

// The coordinator is the run records' controller: the lease it presents on
// every fenced mutation is its own, named so a human reading the record
// knows who held it.
export const LEASE_OWNER = "workbench-clarification-coordinator";

// The display projection of a durable run row for the start's answer: the
// run section's facts, never the lease token or the raw dispatch intent.
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

// The run section and the observation read speak the full snapshot
// vocabulary — everything but the attempt's result column, which is
// lifecycle evidence the ledger's operational events carry in its own time.
const projectAttemptSnapshot = ({ result, ...snapshot }) => snapshot;

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
  const requireCollectedContext = async (issueNumber) => {
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
  // store's request-id uniqueness stays as the durable backstop.) The
  // entry exists only while starts are chaining: once the tail settles
  // and no newer start chained onto it, the map forgets the issue, so the
  // map never grows with the number of issues ever started.
  const inFlightStarts = new Map();
  const serializedFor = (issueId, fn) => {
    const previous = inFlightStarts.get(issueId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => {});
    inFlightStarts.set(issueId, tail);
    void tail.then(() => {
      if (inFlightStarts.get(issueId) === tail) inFlightStarts.delete(issueId);
    });
    return next;
  };

  // One wait list per run id, and a change counter playing the condition
  // variable: a stream that wakes without new events re-reads instead of
  // sleeping through a publish that landed between its read and its wait.
  const waiters = new Map();
  let changeCounter = 0;

  // Wake every stream waiting on the run; `false` is the "a change landed,
  // re-read" signal — only detach resolves a wake with `true`.
  const wakeRun = (runId) => {
    const waiting = waiters.get(runId);
    if (waiting === undefined) return;
    waiters.set(runId, []);
    for (const wake of waiting) wake(false);
  };

  // The durable-first publication: append commits, waiters wake. The
  // returned envelope is the persisted evidence, cursors and all.
  const publishEvent = ({ runId, event }) => {
    const [envelope] = store.appendEvents({ runId, events: [event] });
    changeCounter += 1;
    wakeRun(runId);
    return envelope;
  };

  return {
    publish: publishEvent,

    // The fixed pre-start manifest for one issue: what starting grants,
    // rendered from the fresh collected read and the install's declared
    // provider and data destination, ending with the no-publishing line.
    async manifest({ issueNumber }) {
      const collected = await requireCollectedContext(issueNumber);
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
        // A request id names one submission, one issue, forever: the store
        // dedups on the request id alone, so a replay against a different
        // issue must be a typed rejection — never the other issue's run
        // presented as this start's answer.
        const reused = runs.find((r) => r.requestId === requestId && r.issueId !== issueId);
        if (reused)
          throw clarificationError(
            "request_reused",
            `the request id "${requestId}" already started issue ${reused.issueId} — a request id is never reused across issues`,
          );
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
        const collected = await requireCollectedContext(issueNumber);
        if (!revisionMatches(revision, collected.revision))
          throw clarificationError(
            "manifest_stale",
            `issue ${issueNumber} moved past the revision the manifest showed — a fresh manifest is required before starting`,
          );

        const { run, created } = store.createRun({ issueId, requestId });
        // The store dedups on the request id alone; if the answer is not
        // this issue's run, the request id was spent elsewhere and nothing
        // here may present it as this start's record.
        if (!created && run.issueId !== issueId)
          throw clarificationError(
            "request_reused",
            `the request id "${requestId}" already started issue ${run.issueId} — a request id is never reused across issues`,
          );
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
            result: {
              kind: "start-denied",
              code,
              message: String(error?.message ?? error),
              deniedAt: clock(),
            },
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
          publishEvent({
            runId: run.runId,
            event: {
              type: "lifecycle",
              scope: "attempt",
              id: attempt.attemptId,
              state: "terminal",
              at: clock(),
            },
          });
          throw clarificationError(
            "start_denied",
            `the managed session for issue ${issueNumber} was denied before it could start: ${
              error?.message ?? error
            }`,
            { runId: run.runId, attemptId: attempt.attemptId },
          );
        }
        publishEvent({
          runId: run.runId,
          event: {
            type: "lifecycle",
            scope: "attempt",
            id: attempt.attemptId,
            state: "active",
            at: clock(),
          },
        });
        return { started: true, run: projectRun(run), attempt: projectAttempt(attempt) };
      });
    },

    // The run section's read: lifecycle, attempts, the reconnect snapshot
    // baseline, and the operational event ledger after the viewer's cursor
    // — the same envelope vocabulary the live stream carries, all from the
    // durable record, all open (no lease), with an expired cursor's gap
    // traveling through untouched so the timeline never invents the
    // history it cannot prove.
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
      const ledger = store.readEvents({ runId, afterCursor });
      return {
        run,
        attempts: attempts.map(projectAttemptSnapshot),
        ...(snapshot ? { snapshot: snapshot.snapshot, snapshotSavedAt: snapshot.savedAt } : {}),
        latestCursor: ledger.latestCursor,
        events: ledger.events,
        ...(ledger.gap ? { gap: ledger.gap } : {}),
      };
    },

    // The reconnect read: the run's snapshot plus the events after the
    // viewer's cursor — or the explicit gap when that cursor predates the
    // ledger's retention.
    observe({ runId, afterCursor }) {
      const run = store.getRun(runId);
      if (run === null)
        throw clarificationError("run_not_found", `no run "${runId}" is visible to this host repo`);
      const attempts = store.listAttempts(runId);
      const { events, latestCursor, gap } = store.readEvents({ runId, afterCursor });
      return {
        snapshot: { run, attempts: attempts.map(projectAttemptSnapshot) },
        events,
        latestCursor,
        gap,
      };
    },

    // The live observation stream for one attempt: the retained events
    // after `afterCursor` (with a leading gap frame when the cursor is
    // expired), then every published event as it lands — ending when, and
    // only when, the watched attempt reaches its terminal classification.
    // Run-scope events ride the stream but never end it, and uncertainty
    // is not terminal: `unknown` and `quarantined` keep the stream open
    // until reconciliation resolves the attempt — the lifecycle's
    // `terminal` is the only end. Validation happens before the generator
    // is built, so an unknown run or attempt is a typed error at attach
    // time, not a hang.
    streamEvents({ runId, attemptId, afterCursor }) {
      if (!Number.isInteger(afterCursor) || afterCursor < 0)
        throw clarificationError("invalid_request", "afterCursor must be a non-negative integer");
      const run = store.getRun(runId);
      if (run === null)
        throw clarificationError("run_not_found", `no run "${runId}" is visible to this host repo`);
      const attempt = store.getAttempt(attemptId);
      if (attempt === null || attempt.runId !== runId)
        throw clarificationError(
          "attempt_not_found",
          `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
        );
      const terminalAtAttach = attempt.state === "terminal";

      // Detach must reach a stream suspended in its wait — a generator's
      // return() alone cannot interrupt a pending await — so the detach
      // flag rides with the wake and the loop exits on its own.
      let detached = false;
      let wake = null;

      const waitForChange = async (seenChange) => {
        if (detached) return true;
        if (changeCounter !== seenChange) return false;
        return new Promise((resolve) => {
          const waiting = waiters.get(runId) ?? [];
          waiting.push(resolve);
          wake = resolve;
          waiters.set(runId, waiting);
        });
      };

      async function* stream() {
        let cursor = afterCursor;
        let terminalSeen = terminalAtAttach;
        try {
          while (true) {
            const seenChange = changeCounter;
            const { events, gap } = store.readEvents({ runId, afterCursor: cursor });
            if (gap !== undefined) yield { envelope: EVENT_ENVELOPE_VERSION, gap };
            for (const frame of events) {
              yield frame;
              cursor = frame.cursor;
              const { event } = frame;
              if (
                event.type === "lifecycle" &&
                event.scope === "attempt" &&
                event.id === attemptId &&
                event.state === "terminal"
              )
                terminalSeen = true;
            }
            if (terminalSeen) return;
            if (events.length > 0) continue;
            if (await waitForChange(seenChange)) return;
          }
        } finally {
          detached = true;
          const waiting = waiters.get(runId);
          if (waiting !== undefined && wake !== null) {
            const index = waiting.indexOf(wake);
            if (index !== -1) waiting.splice(index, 1);
          }
          wake = null;
        }
      }

      const iterator = stream();
      return {
        stream: iterator,
        // Detaching is disposal of one viewer: the generator stops, the
        // waiter goes, and nothing else in the run is touched.
        detach: () => {
          detached = true;
          wake?.(true);
        },
      };
    },
  };
};
