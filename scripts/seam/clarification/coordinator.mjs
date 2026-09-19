// The clarification coordinator (spec #221, tickets #230/#231/#236, ADRs
// 0015 + 0020): the Workbench-owned domain module between the seam and the
// managed runtime — typed commands in, typed lifecycle/outcome events out.
// Every event an attempt produces is published into the durable operational
// event ledger FIRST and only then fanned out to attached viewers, so what
// a live viewer sees is always already evidence, and a returning viewer is
// served from the same ledger with the same cursors.
//
// Viewers are observers and nothing else (ADR 0020): attaching, detaching,
// and losing a viewer never mutates the attempt. Cancellation is an
// explicit, confirmed command — never a side effect of a browser going
// away. The ledger itself is the coordination state: publishing wakes the
// waiters, each viewer then reads its own delta from the store, so there is
// no second, in-memory copy of history that could disagree with the durable
// record.
//
// Recovery is the coordinator's other half (ticket #236): when the managed
// runtime dies, the death is recorded — attempt and run land in `unknown`
// with the termination evidence on the attempt — and reconciliation moves
// the record from uncertainty to a classification. Mutations stay fenced
// behind the controller lease; the recovery moves that only record the loss
// of proof stay lease-free, exactly so they remain possible when the lease
// holder is what died.

import { EVENT_ENVELOPE_VERSION } from "./store.mjs";

const observationError = (code, message) => Object.assign(new Error(message), { code });

export const createClarificationCoordinator = ({ store }) => {
  if (!store || typeof store.appendEvents !== "function")
    throw observationError(
      "invalid_coordinator",
      "the coordinator needs a durable run-record store",
    );

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

  // The announce half of publication: the store has already committed, the
  // streams re-read from it. Every recovery command shares this — its
  // lifecycle events land in the ledger inside the store's own transaction,
  // and the wake only ever serves what is durable.
  const announce = (runId) => {
    changeCounter += 1;
    wakeRun(runId);
  };

  return {
    // The durable-first publication: append commits, waiters wake. The
    // returned envelope is the persisted evidence, cursors and all.
    // Appending evidence is a write on the record, so it travels under the
    // run's controller lease.
    publish({ runId, event, leaseToken }) {
      const [envelope] = store.appendEvents({ runId, events: [event], leaseToken });
      announce(runId);
      return envelope;
    },

    // Recovery (ticket #236, ADR 0020): process death ends in an explicit
    // Unknown — never a silent retry, never a false completion — with the
    // termination evidence (proof and uncertainty) on the attempt; then
    // reconciliation resolves the uncertainty to a classification, terminal
    // only with its evidence basis cited; adoption takes a fresh lease, and
    // the one destructive path — discarding retained evidence — is the
    // typed confirmation, nothing softer. Each command commits first and
    // announces after, so a viewer never sees what is not yet durable.
    recordProcessDeath({ runId, attemptId, exit }) {
      const resolved = store.recordProcessDeath({ runId, attemptId, exit });
      announce(runId);
      return resolved;
    },

    beginReconciliation({ runId }) {
      const run = store.beginReconciliation({ runId });
      announce(runId);
      return run;
    },

    resolveReconciliation({ runId, to, basis }) {
      const run = store.resolveReconciliation({ runId, to, basis });
      announce(runId);
      return run;
    },

    beginAttemptReconciliation({ attemptId }) {
      const attempt = store.beginAttemptReconciliation({ attemptId });
      announce(attempt.runId);
      return attempt;
    },

    resolveAttemptReconciliation({ attemptId, to, basis }) {
      const attempt = store.resolveAttemptReconciliation({ attemptId, to, basis });
      announce(attempt.runId);
      return attempt;
    },

    discardRunEvidence({ runId, confirmation }) {
      const run = store.discardRunEvidence({ runId, confirmation });
      announce(runId);
      return run;
    },

    // Adoption of a run whose controller is gone: a fresh lease, a fresh
    // generation. A live lease refuses with who holds it — the "controls
    // moved" facts, no takeover ceremony and no liveness claim. An omitted
    // ttl takes the store's default.
    acquireLease({ runId, owner, ttlMs }) {
      return store.acquireLease({ runId, owner, ttlMs });
    },

    renewLease({ runId, token, ttlMs }) {
      return store.renewLease({ runId, token, ttlMs });
    },

    // Ownership and expiry arithmetic only — never the token.
    getLease(runId) {
      return store.getLease(runId);
    },

    // The reconnect read: the run's snapshot plus the events after the
    // viewer's cursor — or the explicit gap when that cursor predates the
    // ledger's retention.
    observe({ runId, afterCursor }) {
      const run = store.getRun(runId);
      if (run === null)
        throw observationError("run_not_found", `no run "${runId}" is visible to this host repo`);
      const attempts = store.listAttempts(runId);
      const { events, latestCursor, gap } = store.readEvents({ runId, afterCursor });
      return { snapshot: { run, attempts }, events, latestCursor, gap };
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
        throw observationError("invalid_request", "afterCursor must be a non-negative integer");
      const run = store.getRun(runId);
      if (run === null)
        throw observationError("run_not_found", `no run "${runId}" is visible to this host repo`);
      const attempt = store.getAttempt(attemptId);
      if (attempt === null || attempt.runId !== runId)
        throw observationError(
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
