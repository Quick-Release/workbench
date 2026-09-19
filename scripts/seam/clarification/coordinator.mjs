// The clarification coordinator (spec #221, tickets #230/#231, ADRs 0015 +
// 0020): the Workbench-owned domain module between the seam and the managed
// runtime — typed commands in, typed lifecycle/outcome events out. This
// slice is the observation half: every event an attempt produces is
// published into the durable operational event ledger FIRST and only then
// fanned out to attached viewers, so what a live viewer sees is always
// already evidence, and a returning viewer is served from the same ledger
// with the same cursors.
//
// Viewers are observers and nothing else (ADR 0020): attaching, detaching,
// and losing a viewer never mutates the attempt. Cancellation is an
// explicit, confirmed command — never a side effect of a browser going
// away. The ledger itself is the coordination state: publishing wakes the
// waiters, each viewer then reads its own delta from the store, so there is
// no second, in-memory copy of history that could disagree with the durable
// record.

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

  const wakeRun = (runId, stopped = false) => {
    const waiting = waiters.get(runId);
    if (waiting === undefined) return;
    waiters.set(runId, []);
    for (const wake of waiting) wake(stopped);
  };

  return {
    // The durable-first publication: append commits, waiters wake. The
    // returned envelope is the persisted evidence, cursors and all.
    publish({ runId, event }) {
      const [envelope] = store.appendEvents({ runId, events: [event] });
      changeCounter += 1;
      wakeRun(runId);
      return envelope;
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
    // Validation happens before the generator is built, so an unknown run
    // or attempt is a typed error at attach time, not a hang.
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
