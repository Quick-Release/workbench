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
//
// The Clarification draft (ticket #233) rides the same discipline: an open
// read carrying the saved document, its brief-completeness arithmetic, and
// the visible issue-body diff rendered from exactly the bytes publication
// would write; and an explicit save that is fenced like every write and
// moves no lifecycle state — saving a draft is never publication approval.

import { noApprovalLine, noPublishingLine } from "../../../src/types.ts";
import {
  briefCompletenessFor,
  publicationBodyFor,
  renderIssueBodyDiff,
  validateClarificationDraft,
} from "./draft.mjs";
import { NO_DRAFT_GAP } from "./context-packet.mjs";
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
const projectAttemptSnapshot = (attempt) => {
  const snapshot = { ...attempt };
  delete snapshot.result;
  return snapshot;
};

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

  // The fenced append with the same viewer contract: command evidence is
  // durable first, then live viewers learn about it — a fenced write never
  // leaves a connected viewer waiting for an unrelated publish.
  const recordEvent = (runId, event) => {
    const envelope = store.appendEvent({ runId, ...event });
    changeCounter += 1;
    wakeRun(runId);
    return envelope;
  };

  // The live managed sessions this process started: attemptId → the session
  // handle and the lease token the start held. Runtime state is in-memory —
  // the durable record is the ledger — so a dev-server restart finds the
  // record intact and the conversation honestly unavailable; re-driving it
  // is reconciliation's explicit work, never a silent re-dispatch.
  const liveSessions = new Map();

  // The conversation commands' shared gate: validate the request, find the
  // visible attempt, refuse what this process cannot drive, prove the
  // controller lease is still current, deduplicate on the client request id
  // from the durable ledger, and only then let the caller touch the
  // runtime. `dispatch` performs the side effect; it receives the session
  // and a `record` callback that appends the command's operational event
  // under the live lease.
  const conversationCommand = ({ runId, attemptId, requestId, kind }, dispatch) => {
    if (typeof runId !== "string" || runId === "")
      throw clarificationError("invalid_request", "a conversation command names a run id");
    if (typeof attemptId !== "string" || attemptId === "")
      throw clarificationError("invalid_request", "a conversation command names an attempt id");
    if (typeof requestId !== "string" || requestId.trim() === "")
      throw clarificationError("invalid_request", "a conversation command carries a request id");
    const run = store.getRun(runId);
    if (!run)
      throw clarificationError(
        "run_not_found",
        `no clarification run "${runId}" is visible to this host repo`,
      );
    const attempt = store.getAttempt(attemptId);
    if (attempt === null || attempt.runId !== runId)
      throw clarificationError(
        "attempt_not_found",
        `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
      );

    // A client request id names one submission: the ledger answers a
    // replayed command from the record, and the runtime never sees it
    // twice — the reconnect fence for every command, prompts included.
    const ledger = store.readEvents({ runId, afterCursor: 0 });
    const replayed = ledger.events.some(
      ({ event }) =>
        event.type === "operational" && event.kind === kind && event.data?.requestId === requestId,
    );
    if (replayed) return { sent: false, requestId };

    const live = liveSessions.get(attemptId);
    if (live === undefined)
      throw clarificationError(
        "conversation_unavailable",
        `the managed session for attempt "${attemptId}" is not live on this install — the record stays inspectable, and the conversation continues through a new attempt`,
      );
    // Every command is a controller act: the held lease must still be
    // current. An expired lease refuses the command typed — reconciliation
    // is the way back, never a silent adoption.
    store.renewLease({ runId, token: live.leaseToken });
    return dispatch(
      live.session,
      (data) =>
        recordEvent(runId, {
          kind,
          data: { attemptId, requestId, ...data },
          leaseToken: live.leaseToken,
        }),
      live.leaseToken,
    );
  };

  // The turn-shaped commands' shared body — prompt, steer, queue: durable
  // intent first, the runtime dispatch second, a synchronous refusal
  // recorded as evidence and rethrown typed. Acceptance and settlement stay
  // the runtime's signals — and when acceptance fails after the ledger
  // already holds the intent, that uncertainty is evidence too: a typed
  // failure event lands in the ledger and wakes the viewers, so nothing
  // post-dispatch is ever swallowed silently.
  const dispatchTurnCommand = ({ runId, attemptId, requestId, kind, data }, sessionCall) =>
    conversationCommand({ runId, attemptId, requestId, kind }, (session, record, leaseToken) => {
      record(data);
      try {
        const result = sessionCall(session);
        result?.accepted?.catch((error) => {
          publishEvent({
            runId,
            event: {
              type: "operational",
              kind: `${kind}-failed`,
              data: { attemptId, requestId, code: error?.code ?? "unknown" },
              at: clock(),
            },
          });
        });
        // The settlement's own rejection is the same outcome the runtime's
        // frames will show; the acceptance carries the typed evidence.
        result?.settled?.catch(() => {});
        return { sent: true, requestId };
      } catch (error) {
        recordEvent(runId, {
          kind: `${kind}-refused`,
          data: { attemptId, requestId, code: error?.code ?? "unknown" },
          leaseToken,
        });
        throw clarificationError(error?.code ?? "command_refused", String(error?.message ?? error));
      }
    });

  // The queue- and dialog-shaped commands' shared body: dispatch first, then
  // record what the runtime confirmed; a synchronous refusal is recorded as
  // evidence and rethrown typed.
  const dispatchRecordedCommand = (
    { runId, attemptId, requestId, kind, refusedData = {} },
    sessionCall,
    confirmedData,
  ) =>
    conversationCommand({ runId, attemptId, requestId, kind }, (session, record, leaseToken) => {
      try {
        const result = sessionCall(session);
        record(confirmedData(result));
        return {
          sent: true,
          requestId,
          ...(result.cleared !== undefined ? { cleared: result.cleared } : {}),
        };
      } catch (error) {
        recordEvent(runId, {
          kind: `${kind}-refused`,
          data: { attemptId, requestId, ...refusedData, code: error?.code ?? "unknown" },
          leaseToken,
        });
        throw clarificationError(error?.code ?? "command_refused", String(error?.message ?? error));
      }
    });

  // The draft save's lease: a draft write claims no effect on the world —
  // it records the proposal itself — but it lands on the run's record, so
  // it travels under the live controller lease like every write. This
  // process is the lease's legitimate owner: it renews the token a live
  // session holds, and re-arms a fresh generation when the old one expired
  // (a dev-server restart leaves the record fenced but not orphaned). A
  // lease another writer genuinely holds fences the save typed — never a
  // silent adoption, never a queue.
  const ensureDraftLease = ({ runId, attemptId }) => {
    const held = liveSessions.get(attemptId)?.leaseToken;
    if (held !== undefined) {
      try {
        store.renewLease({ runId, token: held });
        return held;
      } catch {
        // Expired or superseded: a fresh acquisition decides who may hold
        // the lease now — it is the authority on that, not this check.
      }
    }
    try {
      const { lease } = store.acquireLease({ runId, owner: LEASE_OWNER });
      // The new generation is this process's: a live session's commands
      // renew through the token it holds, so the handle follows the lease.
      const live = liveSessions.get(attemptId);
      if (live !== undefined) live.leaseToken = lease.token;
      return lease.token;
    } catch (error) {
      if (error?.code === "lease_held")
        throw clarificationError(
          "busy",
          `the controller lease for run "${runId}" is held elsewhere — saving the draft is fenced until it moves`,
        );
      throw error;
    }
  };

  // The draft view: the saved document (or its honest absence), the brief
  // completeness arithmetic over the task profile, and the visible
  // issue-body diff rendered from exactly the bytes publication would
  // write — computed against a fresh tracker read. A tracker read that
  // cannot answer withholds the diff and says why; it never hides the
  // locally persisted draft, which is the one thing this install owns.
  const draftView = async ({ runId, attemptId }) => {
    if (typeof runId !== "string" || runId === "")
      throw clarificationError("invalid_request", "a draft read names a run id");
    if (typeof attemptId !== "string" || attemptId === "")
      throw clarificationError("invalid_request", "a draft read names an attempt id");
    const run = store.getRun(runId);
    if (!run)
      throw clarificationError(
        "run_not_found",
        `no clarification run "${runId}" is visible to this host repo`,
      );
    const attempt = store.getAttempt(attemptId);
    if (attempt === null || attempt.runId !== runId)
      throw clarificationError(
        "attempt_not_found",
        `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
      );

    const saved = store.getDraft(attemptId);
    const draft = saved?.draft ?? null;
    const completeness = draft
      ? briefCompletenessFor(draft)
      : { verdict: "needs-information", gaps: [NO_DRAFT_GAP] };

    const warnings = [];
    let issue = null;
    const issueNumber = Number(run.issueId);
    if (Number.isInteger(issueNumber) && issueNumber > 0) {
      try {
        const collected = await tracker.readContext({ issueNumber });
        if (collected && !collected.failed && collected.issue)
          issue = {
            number: collected.issue.number,
            revision: {
              updatedAt: collected.revision.updatedAt,
              bodyHash: collected.revision.bodyHash,
            },
            body: collected.issue.body ?? "",
          };
        else
          warnings.push(
            collected?.warnings?.length
              ? collected.warnings.join(" ")
              : "the tracker read is incomplete; the visible issue-body diff withholds until a fresh read succeeds",
          );
      } catch (error) {
        warnings.push(
          `the tracker read failed (${error instanceof Error ? error.message : "read failed"}); the visible issue-body diff withholds until a fresh read succeeds`,
        );
      }
    } else {
      warnings.push(
        `the run's issue id "${run.issueId}" is not an issue number; the visible issue-body diff has no base to differ from`,
      );
    }

    const diff =
      issue !== null && draft
        ? renderIssueBodyDiff({ before: issue.body, after: publicationBodyFor(draft) })
        : null;

    return {
      runId,
      attemptId,
      draft,
      gaps: completeness.gaps,
      briefCompleteness: completeness.verdict,
      issue,
      diff,
      warnings,
      savingIsNotApproval: noApprovalLine,
      ...(saved ? { savedAt: saved.updatedAt } : {}),
    };
  };

  // The Developer's explicit save: typed shape gate first, the fenced
  // durable write second, the save's evidence in the ledger third — and
  // the answer is the fresh draft view. Saving never touches the
  // lifecycle: it is not approval, and nothing about the run or attempt
  // moves.
  const saveDraft = async ({ runId, attemptId, draft }) => {
    if (typeof runId !== "string" || runId === "")
      throw clarificationError("invalid_request", "a draft save names a run id");
    if (typeof attemptId !== "string" || attemptId === "")
      throw clarificationError("invalid_request", "a draft save names an attempt id");
    const validated = validateClarificationDraft(draft);
    const run = store.getRun(runId);
    if (!run)
      throw clarificationError(
        "run_not_found",
        `no clarification run "${runId}" is visible to this host repo`,
      );
    const attempt = store.getAttempt(attemptId);
    if (attempt === null || attempt.runId !== runId)
      throw clarificationError(
        "attempt_not_found",
        `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
      );
    const leaseToken = ensureDraftLease({ runId, attemptId });
    store.saveDraft({ attemptId, draft: validated, leaseToken });
    const { gaps } = briefCompletenessFor(validated);
    // The save's evidence shares the publication contract: durable first,
    // waiters woken second — a connected viewer sees the timeline entry the
    // moment the save commits, never an unrelated publish later.
    recordEvent(runId, {
      kind: "draft.saved",
      data: { attemptId, profile: validated.profile, gapCount: gaps.length },
      leaseToken,
    });
    return draftView({ runId, attemptId });
  };

  // The evidence pump: the runtime's frames become durable conversation
  // events as they land — ledger first, viewer fan-out second, so what a
  // live viewer sees is always already evidence. One pump per live attempt,
  // from the start of the retained buffer; it ends when the session's
  // stream ends. A session whose port cannot stream records everything
  // else; the runtime's own history still reads back. A pump that dies with
  // its stream records that too — the silence would claim a live runtime.
  const pumpAttempt = ({ runId, attemptId, session }) => {
    if (typeof session?.subscribe !== "function") return;
    void (async () => {
      try {
        for await (const frame of session.subscribe(0)) {
          if (frame === null || typeof frame !== "object" || Array.isArray(frame)) continue;
          publishEvent({
            runId,
            event: {
              type: "conversation",
              attemptId,
              session: { cursor: frame.cursor, envelope: frame.envelope, event: frame.event },
            },
          });
        }
      } catch (error) {
        publishEvent({
          runId,
          event: {
            type: "operational",
            kind: "conversation.stream-failed",
            data: { attemptId, code: error?.code ?? "unknown" },
            at: clock(),
          },
        });
      }
    })();
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
          const session = await sessions.start({
            runId: run.runId,
            attemptId: attempt.attemptId,
            issueNumber,
          });
          // The one live handle: commands drive this session, fenced by the
          // lease the start holds — and its frames pump into the ledger.
          liveSessions.set(attempt.attemptId, { session, leaseToken: token });
          pumpAttempt({ runId: run.runId, attemptId: attempt.attemptId, session });
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

    // The run for one issue, latest first: how the issue panel finds the
    // conversation again after a refresh. No run is an honest null — the
    // panel then renders the manifest, never a fabricated attempt.
    async runForIssue({ issueNumber }) {
      if (!Number.isInteger(issueNumber) || issueNumber <= 0)
        throw clarificationError("invalid_request", "an issue is a positive integer");
      const issueId = String(issueNumber);
      const runs = store
        .listRuns()
        .filter((run) => run.issueId === issueId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return runs[0] ?? null;
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

    // The Clarification draft read and save (ticket #233): open read, and
    // an explicit save that is never an approval.
    draftView,
    saveDraft,

    // The Developer's explicit prompt: durable evidence first, the runtime
    // dispatch second, acceptance and settlement staying the runtime's own
    // signals. A prompt while a turn is live is a typed refusal — the
    // explicit ways to hold work are steer and queue, never a hidden queue.
    sendPrompt({ runId, attemptId, requestId, text }) {
      if (typeof text !== "string" || text.trim() === "")
        throw clarificationError("invalid_request", "a prompt needs a non-empty text");
      return dispatchTurnCommand(
        { runId, attemptId, requestId, kind: "conversation.prompt", data: { text } },
        (session) => session.sendPrompt(text),
      );
    },

    // Steer rides the live turn — explicit guidance, never an implicit
    // interruption and never a second prompt.
    steer({ runId, attemptId, requestId, text }) {
      if (typeof text !== "string" || text.trim() === "")
        throw clarificationError("invalid_request", "a steer needs a non-empty text");
      return dispatchTurnCommand(
        { runId, attemptId, requestId, kind: "conversation.steer", data: { text } },
        (session) => session.steer(text),
      );
    },

    // A follow-up queues behind the live turn — explicit, bounded, FIFO.
    queueFollowUp({ runId, attemptId, requestId, text }) {
      if (typeof text !== "string" || text.trim() === "")
        throw clarificationError("invalid_request", "a follow-up needs a non-empty text");
      return dispatchTurnCommand(
        { runId, attemptId, requestId, kind: "conversation.follow-up-queued", data: { text } },
        (session) => session.queueFollowUp(text),
      );
    },

    // Drops every queued follow-up — they will never deliver — and the
    // runtime is told to clear whatever it holds queued too.
    clearQueue({ runId, attemptId, requestId }) {
      return dispatchRecordedCommand(
        { runId, attemptId, requestId, kind: "conversation.queue-cleared" },
        (session) => session.clearQueue(),
        (result) => ({ cleared: result.cleared }),
      );
    },

    // Stop-turn: the queue clears FIRST, then the live turn aborts — the
    // stop's evidence names exactly which held work died with it.
    stopTurn({ runId, attemptId, requestId }) {
      return dispatchRecordedCommand(
        { runId, attemptId, requestId, kind: "conversation.turn-stopped" },
        (session) => session.stopTurn(),
        (result) => ({ cleared: result.cleared }),
      );
    },

    // The conversation's live state read: the session's own word for where
    // it stands, its typed pending questions, and the unsupported
    // capabilities it surfaced. Open like every read — no lease — and
    // honest about a session this process cannot drive.
    conversationState({ runId, attemptId }) {
      if (typeof runId !== "string" || runId === "")
        throw clarificationError("invalid_request", "a conversation state read names a run id");
      if (typeof attemptId !== "string" || attemptId === "")
        throw clarificationError(
          "invalid_request",
          "a conversation state read names an attempt id",
        );
      const attempt = store.getAttempt(attemptId);
      if (attempt === null || attempt.runId !== runId)
        throw clarificationError(
          "attempt_not_found",
          `no attempt "${attemptId}" is visible on run "${runId}" in this host repo`,
        );
      const live = liveSessions.get(attemptId);
      if (live === undefined) return { available: false };
      // sessionState is optional in the seam's contract: a session that
      // cannot name its state omits the field rather than sending a null
      // the schema would refuse.
      const sessionState = live.session.state?.();
      return {
        available: true,
        ...(typeof sessionState === "string" ? { sessionState } : {}),
        pendingDialogs: live.session.pendingDialogs?.() ?? [],
        unsupportedCapabilities: live.session.unsupportedCapabilities?.() ?? [],
      };
    },

    // Answers a typed dialog — the Developer's explicit response, recorded
    // with the value the runtime receives.
    answerDialog({ runId, attemptId, requestId, dialogId, value }) {
      if (typeof dialogId !== "string" || dialogId === "")
        throw clarificationError("invalid_request", "a dialog answer names the dialog");
      if (value === undefined)
        throw clarificationError("invalid_request", "a dialog answer carries a value");
      return dispatchRecordedCommand(
        {
          runId,
          attemptId,
          requestId,
          kind: "conversation.dialog-answered",
          refusedData: { dialogId },
        },
        (session) => session.answerDialog({ dialogId, value }),
        () => ({ dialogId, value }),
      );
    },

    // Cancels a typed dialog — a typed cancellation, never a default.
    cancelDialog({ runId, attemptId, requestId, dialogId }) {
      if (typeof dialogId !== "string" || dialogId === "")
        throw clarificationError("invalid_request", "a dialog cancellation names the dialog");
      return dispatchRecordedCommand(
        {
          runId,
          attemptId,
          requestId,
          kind: "conversation.dialog-cancelled",
          refusedData: { dialogId },
        },
        (session) => session.cancelDialog({ dialogId }),
        () => ({ dialogId }),
      );
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
