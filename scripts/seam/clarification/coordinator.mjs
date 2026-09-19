// The clarification coordinator (spec #221, tickets #230/#231/#235, ADRs
// 0015 + 0020 + 0023): the Workbench-owned domain module between the seam
// and the managed runtime — typed commands in, typed lifecycle/outcome
// events out.
//
// The observation half: every event an attempt produces is published into
// the durable operational event ledger FIRST and only then fanned out to
// attached viewers, so what a live viewer sees is always already evidence,
// and a returning viewer is served from the same ledger with the same
// cursors. Viewers are observers and nothing else (ADR 0020): attaching,
// detaching, and losing a viewer never mutates the attempt. Cancellation is
// an explicit, confirmed command — never a side effect of a browser going
// away. The ledger itself is the coordination state: publishing wakes the
// waiters, each viewer then reads its own delta from the store, so there is
// no second, in-memory copy of history that could disagree with the durable
// record.
//
// The failure-policy half (ticket #235, ADR 0023): an observed outcome is
// classified into the Workbench-owned failure taxonomy, and the
// classification — never the raw error — decides what happens next. Quota
// and authentication failures park the attempt awaiting-human with the
// usage budget preserved; nothing retries, falls back, or overruns. After
// dispatch, every retry is the Developer's manual fresh attempt; the ONE
// coordinator retry exists behind durable evidence that no provider or tool
// dispatch occurred — the attempt carries no dispatch mark and its outcome
// is one of the pre-dispatch start denials. Repeated identical failure
// signatures halt the run awaiting-human with an escalation record, the
// bounded handoff that names the next human decision. Every step lands in
// the ledger in the same commit as the record move it drives, so evidence
// and state cannot disagree.

import { EVENT_ENVELOPE_VERSION } from "./store.mjs";
import {
  FAILURE_SIGNATURE_HALT,
  NON_DISPATCH_OUTCOME_KINDS,
  classifyOutcome,
  escalationFor,
  failureSignature,
  summarizeUsageBudget,
  usageLine,
} from "./failures.mjs";

const observationError = (code, message) => Object.assign(new Error(message), { code });

export const createClarificationCoordinator = ({
  store,
  clock = () => new Date().toISOString(),
}) => {
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

  // The failure-policy commands mutate the ledger through the store's own
  // atomic commits, then wake the viewers — the durable-first rule holds:
  // no stream is told anything that is not already committed.
  const notify = (runId) => {
    changeCounter += 1;
    wakeRun(runId);
  };

  // The typed rejections the retry gate hands back, with the reason named.
  const retryNotEligible = (why) =>
    observationError(
      "retry_not_eligible",
      `the coordinator retry fires only on durable evidence that no provider or tool dispatch occurred: ${why}`,
    );

  return {
    // The durable-first publication: append commits, waiters wake. The
    // returned envelope is the persisted evidence, cursors and all.
    publish({ runId, event }) {
      const [envelope] = store.appendEvents({ runId, events: [event] });
      changeCounter += 1;
      wakeRun(runId);
      return envelope;
    },

    // The failure policy's entry point (ADR 0023): one observed outcome in,
    // the full classified policy applied. The outcome event, the lifecycle
    // move it drives, and the attempt's verdict commit as one store
    // transaction — then the no-progress detector counts the failure's
    // bounded signature, and the second identical one halts the run
    // awaiting-human with an escalation record. A provider-reported usage
    // object folds into the durable budget as a `reported` line, verbatim.
    // The outcome shape is closed: anything the policy cannot classify is a
    // typed rejection that writes nothing.
    recordOutcome({ runId, attemptId, outcome }) {
      const verdict = classifyOutcome(outcome);
      const attempt = store.getAttempt(attemptId);
      if (attempt === null || attempt.runId !== runId)
        throw observationError(
          "attempt_not_found",
          `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
        );
      const at = clock();
      const signature = failureSignature(verdict);
      const outcomeEvent = {
        type: "outcome",
        scope: "attempt",
        id: attemptId,
        kind: verdict.kind,
        classification: verdict.classification,
        nextAction: verdict.nextAction,
        ...(verdict.reason !== null ? { reason: verdict.reason } : {}),
        ...(signature !== undefined ? { signature } : {}),
        ...(verdict.usage !== null ? { usage: verdict.usage } : {}),
        at,
      };
      const lifecycleEvent = {
        type: "lifecycle",
        scope: "attempt",
        id: attemptId,
        state: verdict.attemptState,
        at,
      };
      // The store rejects the whole transaction when the attempt's
      // lifecycle cannot take this outcome (a terminal attempt records
      // nothing further) — evidence and record move together or not at all.
      const updated = store.updateAttemptState({
        attemptId,
        to: verdict.attemptState,
        events: [outcomeEvent, lifecycleEvent],
        verdict: {
          kind: verdict.kind,
          classification: verdict.classification,
          nextAction: verdict.nextAction,
          reason: verdict.reason,
          signature,
          at,
        },
      });
      notify(runId);

      // The budget folds AFTER its evidence committed: usage is never
      // recorded for an outcome the record refused.
      if (verdict.usage !== null) {
        store.appendUsageLines({
          runId,
          lines: [{ kind: "reported", unit: "provider", detail: verdict.usage, attemptId }],
        });
        notify(runId);
      }

      // The no-progress detector: failures carry a bounded signature; the
      // second identical one is a loop, and the run halts awaiting-human
      // with the escalation record — the bounded handoff naming the next
      // human decision.
      let halted = false;
      if (signature !== undefined) {
        const { count } = store.recordFailureSignature({ runId, signature, attemptId });
        if (count >= FAILURE_SIGNATURE_HALT) {
          try {
            store.haltRun({
              runId,
              record: escalationFor({
                runId,
                attemptId,
                verdict,
                signature,
                repeats: count,
                at: clock(),
              }),
            });
            halted = true;
          } catch (error) {
            // This signature already escalated: the halt stands, nothing
            // new is recorded.
            if (error?.code !== "already_halted") throw error;
          }
          notify(runId);
        }
      }
      return { ...updated.outcome, attemptState: updated.state, halted };
    },

    // The dispatch mark: durable evidence that the managed runtime became
    // ready and the dispatch window opened on this attempt. From here on,
    // "no dispatch occurred" can never be proven again — the one coordinator
    // retry is gone for this attempt, whatever its outcome claims.
    markDispatched({ runId, attemptId, evidence }) {
      const attempt = store.getAttempt(attemptId);
      if (attempt === null || attempt.runId !== runId)
        throw observationError(
          "attempt_not_found",
          `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
        );
      const marked = store.markAttemptDispatched({
        attemptId,
        at: clock(),
        evidence: evidence ?? null,
      });
      notify(runId);
      return marked;
    },

    // The ONE coordinator retry (ADR 0023): fired only when durable
    // evidence proves no provider or tool dispatch occurred — the failed
    // attempt carries no dispatch mark, and its recorded outcome is one of
    // the pre-dispatch start denials. The store's partial unique index
    // makes the second coordinator-created attempt on a run a typed refusal,
    // so "at most once" is the schema's law, not a promise. Every other
    // retry is the Developer's manual fresh attempt on a re-rendered
    // manifest. A replayed request id deduplicates to the same attempt.
    requestCoordinatorRetry({ runId, fromAttemptId, requestId, intent }) {
      const run = store.getRun(runId);
      if (run === null)
        throw observationError("run_not_found", `no run "${runId}" is visible to this host repo`);
      if (run.state !== "active")
        throw observationError(
          "run_not_active",
          `run "${runId}" is ${run.state} — a halted run dispatches nothing until the human decides`,
        );
      const from = store.getAttempt(fromAttemptId);
      if (from === null || from.runId !== runId)
        throw observationError(
          "attempt_not_found",
          `no attempt "${fromAttemptId}" is visible on run "${runId}" in this host repo`,
        );
      if (from.outcome === undefined || from.outcome === null)
        throw retryNotEligible(`attempt "${fromAttemptId}" has no recorded outcome`);
      if (!NON_DISPATCH_OUTCOME_KINDS.includes(from.outcome.kind))
        throw retryNotEligible(
          `the recorded outcome "${from.outcome.kind}" does not prove non-dispatch`,
        );
      if (from.dispatchedAt !== undefined)
        throw retryNotEligible(`attempt "${fromAttemptId}" carries a dispatch mark`);
      const { attempt, created } = store.createAttempt({
        runId,
        requestId,
        intent,
        origin: "coordinator-retry",
      });
      if (created) {
        this.publish({
          runId,
          event: {
            type: "retry",
            scope: "run",
            id: runId,
            fromAttemptId,
            attemptId: attempt.attemptId,
            basis: "proven-non-dispatch",
            at: clock(),
          },
        });
      }
      return { attempt, created };
    },

    // One line into the durable usage budget. The kind — reported,
    // estimated, unknown — travels with the line forever; the policy module
    // validates the shape, and an unknown line refuses a value outright.
    recordUsage({ runId, attemptId, line }) {
      const validated = usageLine(line);
      const [stored] = store.appendUsageLines({
        runId,
        lines: [{ ...validated, ...(attemptId !== undefined ? { attemptId } : {}) }],
      });
      return stored;
    },

    // The run's budget: every line with its kind, plus the honest totals —
    // sums within one kind and unit, never across; unknown lines are
    // counted, never summed.
    usageBudget({ runId }) {
      const { lines } = store.usageBudgetFor(runId);
      return { runId, lines, totals: summarizeUsageBudget(lines) };
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
