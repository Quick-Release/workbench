import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { bodyDigestFor } from "./approval.mjs";
import { LEASE_OWNER, createClarificationCoordinator } from "./coordinator.mjs";
import { publicationBodyFor } from "./draft.mjs";
import { DEFAULT_LEASE_TTL_MS, openClarificationStore } from "./store.mjs";

// The Factory 07 durable-ownership injection matrix (spec #221, ticket #239,
// ADR 0020, the injection list in #165's resolution): one `describe` per
// injection, each driving typed commands and fault injections into the
// coordinator and asserting the typed outcome. Every injection asserts the
// same three invariants where they apply — no duplicate execution (the
// managed session start, the runtime prompt, the tracker write each happen
// at most once per durable intent), no false completion (nothing reads
// terminal or succeeded without the evidence that proves it), and no
// path-only deletion (destroying evidence takes the record's own identity,
// its host-repo scope, and the typed confirmation — never a matching
// database path or a lookalike id).
//
// The tier: the real SQLite store on a temp directory behind the
// coordinator, so durability and fencing are the store's real semantics.
// A "controller" is one coordinator over its own database connection — two
// controllers on one file are two processes; abandoning one and opening
// another on the same file is a restart. Storage failures are injected
// through the store port (a proxy that throws on chosen writes), never by
// corrupting files. The tracker and the managed session are scripted
// fakes; the clock is shared and moved by the test. No network, no real
// Pi, no real sleeps.

const HOST = "Quick-Release/workbench";
const ISSUE = 239;
const REVISION = Object.freeze({ updatedAt: "2026-11-12T09:00:00.000Z", bodyHash: "sha-256:base" });

const collected = ({ body = "the body", revision = REVISION } = {}) => ({
  repo: HOST,
  issue: { number: ISSUE, title: "Clarification 18", body, state: "OPEN" },
  revision: { ...revision },
  issueProvenance: { source: "tracker", locator: `${HOST}#${ISSUE}` },
  blockers: [],
  warnings: [],
  capped: false,
  failed: false,
});

// The tracker fake: reads answer the issue; a delivered write changes what
// later reads serve, so a read-back proves the write — and every write is
// counted, the publication's duplicate-execution witness.
const scriptedTracker = () => {
  const writes = [];
  let served = collected();
  return {
    writes,
    readContext: async () => served,
    updateIssueBody: async ({ issueNumber, body }) => {
      writes.push({ issueNumber, body });
      served = collected({
        body,
        revision: { updatedAt: "2026-11-12T10:30:00.000Z", bodyHash: bodyDigestFor(body) },
      });
      return { delivered: true };
    },
  };
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// One scripted managed session: every runtime call is counted (the
// duplicate-execution witness), every prompt's acceptance and settlement
// stay the test's to deliver, lose, or fail, and frames the test emits
// stream through `subscribe` into the coordinator's pump.
const scriptedSession = (sessionId) => {
  const session = {
    sessionId,
    prompts: [],
    frames: [],
    frameWaiters: [],
    closed: false,
    state: () => "ready",
    pendingDialogs: () => [],
    unsupportedCapabilities: () => [],
    sendPrompt: (text) => {
      const accepted = deferred();
      const settled = deferred();
      session.prompts.push({ text, accepted, settled });
      return {
        requestId: `req_${session.prompts.length}`,
        accepted: accepted.promise,
        settled: settled.promise,
      };
    },
    emit: (event) => {
      session.frames.push({ cursor: session.frames.length + 1, envelope: "pi-managed/v1", event });
      for (const wake of session.frameWaiters.splice(0)) wake();
    },
    end: () => {
      session.closed = true;
      for (const wake of session.frameWaiters.splice(0)) wake();
    },
    subscribe: async function* (fromCursor) {
      let last = fromCursor;
      while (true) {
        for (const frame of session.frames)
          if (frame.cursor > last) {
            last = frame.cursor;
            yield frame;
          }
        if (session.closed) return;
        await new Promise((resolve) => session.frameWaiters.push(resolve));
      }
    },
  };
  return session;
};

// The managed session port. `mode` decides how the next start answers:
// "ack" resolves with a live session, "hold" never answers (the dispatch
// is in flight when the controller dies), "deny" rejects with a typed
// start denial. `starts` counts every dispatch any controller sent.
const sessionPort = () => {
  const port = {
    mode: "ack",
    starts: [],
    sessions: [],
    held: [],
    start: async (args) => {
      port.starts.push(args);
      if (port.mode === "deny")
        throw Object.assign(new Error("the runtime ended before its handshake"), {
          code: "runtime_ended",
        });
      if (port.mode === "hold") {
        const pending = deferred();
        port.held.push(pending);
        return pending.promise;
      }
      const session = scriptedSession(`pi-${args.attemptId}`);
      port.sessions.push(session);
      return session;
    },
  };
  return port;
};

// The shared, test-driven clock: expiry is arithmetic, never a sleep.
const testClock = () => {
  let now = Date.parse("2026-11-12T10:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  clock.tick = (ms) => {
    now += ms;
  };
  return clock;
};

// A storage failure the way node:sqlite surfaces one.
const storageFault = (method) =>
  Object.assign(new Error(`disk I/O error (injected into ${method})`), {
    code: "ERR_SQLITE_ERROR",
    errcode: 10,
    errstr: "disk I/O error",
  });

// The store port with fault injection: `arm(method, when)` makes the named
// method throw a storage fault whenever `when(args)` holds (always, by
// default) — before the real store is touched, so the injected write never
// half-happens. Everything else passes through to the real store.
const faultInjected = (store) => {
  const armed = new Map();
  const port = new Proxy(store, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      return (...args) => {
        const when = armed.get(key);
        if (when !== undefined && when(...args)) throw storageFault(String(key));
        return value(...args);
      };
    },
  });
  return {
    port,
    arm: (method, when = () => true) => armed.set(method, when),
    disarm: (method) => armed.delete(method),
  };
};

// The rig: one temp database file, one clock, one tracker, one session
// port — and any number of controllers opened on that file.
const withRig = async (fn, { eventLedgerLimit } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-ownership-matrix-"));
  const databasePath = join(directory, "runs.sqlite");
  const clock = testClock();
  const tracker = scriptedTracker();
  const sessions = sessionPort();
  const opened = [];
  const controller = ({ hostRepo = HOST } = {}) => {
    const store = openClarificationStore({
      hostRepo,
      databasePath,
      clock,
      ...(eventLedgerLimit !== undefined ? { eventLedgerLimit } : {}),
    });
    opened.push(store);
    const faults = faultInjected(store);
    const coordinator = createClarificationCoordinator({
      store: faults.port,
      tracker,
      sessions,
      clock,
      provider: "openai-codex-oauth",
      dataDestination: "https://api.openai.com",
      hostRepo,
    });
    return { store, faults, coordinator };
  };
  try {
    return await fn({ databasePath, clock, tracker, sessions, controller });
  } finally {
    for (const store of opened)
      try {
        store.close();
      } catch {
        // A store the test already closed (a crashed controller) stays closed.
      }
    await rm(directory, { recursive: true, force: true });
  }
};

const startArgs = (requestId) => ({ issueNumber: ISSUE, requestId, revision: { ...REVISION } });

// The ledger's operational kinds and lifecycle moves, in order — what the
// durable evidence says happened.
const ledger = (store, runId) =>
  store
    .readEvents({ runId, afterCursor: 0 })
    .events.map(({ event }) =>
      event.type === "operational"
        ? event.kind
        : event.type === "lifecycle"
          ? `lifecycle:${event.scope}:${event.state}`
          : event.type,
    );

const DRAFT = Object.freeze({
  version: "clarification-draft/v1",
  profile: "bug",
  behavior: "the brief's expected behavior",
  observation: "",
  reproduction: "",
  boundary: "",
  scope: "the bounded scope",
  exclusions: [],
  acceptance: ["one observable criterion"],
  dependencies: "",
  performanceClaim: "",
  performanceEvidence: "",
  assumptions: [],
  evidence: [],
});

const approveArgs = ({ runId, attemptId }, requestId = "approve-1") => ({
  runId,
  attemptId,
  requestId,
  revision: { ...REVISION },
  bodyDigest: bodyDigestFor(publicationBodyFor(DRAFT)),
});

// Awaits every pending microtask and macrotask the pump or an ack handler
// queued — a real-time-free settle, not a sleep.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Collects unhandled rejections while `fn` runs: a storage failure on an
// asynchronous evidence path must surface as evidence or nothing — never
// as an unhandled rejection that takes the controller process down.
const collectingUnhandled = async (fn) => {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await fn();
    await settle();
    await settle();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
};

// ---------------------------------------------------------------------------

describe("Factory 07 injection: duplicate starts", () => {
  it("a replayed start request answers the durable record and dispatches once", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, store } = controller();
      const first = await coordinator.start(startArgs("start-1"));
      const replay = await coordinator.start(startArgs("start-1"));

      strictEqual(first.started, true);
      strictEqual(replay.started, false);
      strictEqual(replay.run.runId, first.run.runId);
      strictEqual(replay.attempt.attemptId, first.attempt.attemptId);
      strictEqual(sessions.starts.length, 1);
      strictEqual(store.listRuns().length, 1);
      strictEqual(store.listAttempts(first.run.runId).length, 1);
    });
  });

  it("racing submissions of the same request dispatch once", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, store } = controller();
      const answers = await Promise.all([
        coordinator.start(startArgs("start-1")),
        coordinator.start(startArgs("start-1")),
        coordinator.start(startArgs("start-1")),
      ]);
      strictEqual(answers.filter((a) => a.started).length, 1);
      strictEqual(new Set(answers.map((a) => a.attempt.attemptId)).size, 1);
      strictEqual(sessions.starts.length, 1);
      strictEqual(store.listAttempts(answers[0].run.runId).length, 1);
    });
  });

  it("racing distinct requests for one issue start one run; the rest are typed busy", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, store } = controller();
      const settled = await Promise.allSettled([
        coordinator.start(startArgs("start-a")),
        coordinator.start(startArgs("start-b")),
      ]);
      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const refused = settled.filter((s) => s.status === "rejected");
      strictEqual(fulfilled.length, 1);
      strictEqual(refused.length, 1);
      strictEqual(refused[0].reason.code, "busy");
      strictEqual(sessions.starts.length, 1);
      strictEqual(store.listRuns().length, 1);
    });
  });

  it("the same request submitted to two controllers of one host repo dispatches once", async () => {
    await withRig(async ({ controller, sessions }) => {
      const a = controller();
      const b = controller();
      // Two processes, no shared memory: only the durable record can
      // serialize them.
      const settled = await Promise.allSettled([
        a.coordinator.start(startArgs("start-1")),
        b.coordinator.start(startArgs("start-1")),
      ]);
      strictEqual(sessions.starts.length, 1);
      // The loser either reads the winner's record or is refused busy by the
      // winner's live lease — never a second attempt.
      for (const outcome of settled)
        if (outcome.status === "rejected") strictEqual(outcome.reason.code, "busy");
        else ok(outcome.value.attempt.attemptId);
      const runs = a.store.listRuns();
      strictEqual(runs.length, 1);
      strictEqual(a.store.listAttempts(runs[0].runId).length, 1);
    });
  });
});

describe("Factory 07 injection: concurrent controllers", () => {
  it("a second controller is fenced from every write while the first holds the lease", async () => {
    await withRig(async ({ controller, sessions }) => {
      const a = controller();
      const b = controller();
      const { run, attempt } = await a.coordinator.start(startArgs("start-1"));
      const before = ledger(a.store, run.runId);

      throws(
        () => b.coordinator.acquireLease({ runId: run.runId, owner: "controller-b" }),
        (error) => error.code === "lease_held",
      );
      await rejects(
        () =>
          b.coordinator.saveDraft({ runId: run.runId, attemptId: attempt.attemptId, draft: DRAFT }),
        (error) => error.code === "busy",
      );
      throws(
        () =>
          b.coordinator.recordOutcome({
            runId: run.runId,
            attemptId: attempt.attemptId,
            outcome: { kind: "cancelled" },
          }),
        (error) => error.code === "busy",
      );
      // A fresh start through the second controller is the in-flight
      // refusal, not a second dispatch.
      await rejects(
        () => b.coordinator.start(startArgs("start-2")),
        (error) => error.code === "busy",
      );

      // Nothing the fenced controller tried landed: no draft, no outcome,
      // no new evidence, one dispatch.
      strictEqual(a.store.getDraft(attempt.attemptId), null);
      strictEqual(a.store.getAttempt(attempt.attemptId).state, "active");
      strictEqual(a.store.getAttempt(attempt.attemptId).result, null);
      deepStrictEqual(ledger(a.store, run.runId), before);
      strictEqual(sessions.starts.length, 1);
    });
  });

  it("once a newer generation exists, the older controller cannot reach the runtime", async () => {
    await withRig(async ({ controller, clock, sessions }) => {
      const a = controller();
      const b = controller();
      const { run, attempt } = await a.coordinator.start(startArgs("start-1"));
      const [session] = sessions.sessions;

      clock.tick(DEFAULT_LEASE_TTL_MS + 1);
      const adopted = b.coordinator.acquireLease({ runId: run.runId, owner: "controller-b" });
      strictEqual(adopted.lease.generation, 2);

      // The first controller still holds a live session handle — and its
      // superseded token. The prompt is refused before the intent is
      // recorded and before the runtime sees anything.
      throws(
        () =>
          a.coordinator.sendPrompt({
            runId: run.runId,
            attemptId: attempt.attemptId,
            requestId: "prompt-1",
            text: "go on",
          }),
        (error) => error.code === "lease_not_held",
      );
      strictEqual(session.prompts.length, 0);
      ok(!ledger(a.store, run.runId).includes("conversation.prompt"));

      // Its policy writes re-arm only when nobody else holds the lease: the
      // live generation 2 fences them typed.
      throws(
        () =>
          a.coordinator.recordOutcome({
            runId: run.runId,
            attemptId: attempt.attemptId,
            outcome: { kind: "cancelled" },
          }),
        (error) => error.code === "busy",
      );
      strictEqual(a.store.getAttempt(attempt.attemptId).state, "active");
    });
  });
});

describe("Factory 07 injection: stale leases", () => {
  it("an expired token cannot write a late completion, cancellation, cleanup result, or retry decision", async () => {
    await withRig(async ({ controller, clock }) => {
      const { store } = controller();
      const { run } = store.createRun({ issueId: String(ISSUE), requestId: "r-1" });
      const { lease } = store.acquireLease({ runId: run.runId, owner: LEASE_OWNER });
      const { attempt } = store.createAttempt({
        runId: run.runId,
        requestId: "r-1",
        intent: { kind: "clarification-start" },
        leaseToken: lease.token,
      });
      clock.tick(DEFAULT_LEASE_TTL_MS);

      const late = [
        // A late completion.
        () =>
          store.recordAttemptOutcome({
            attemptId: attempt.attemptId,
            to: "terminal",
            result: { kind: "published" },
            event: { kind: "publication.succeeded", data: {} },
            leaseToken: lease.token,
          }),
        // A late cancellation.
        () =>
          store.recordAttemptOutcome({
            attemptId: attempt.attemptId,
            to: "terminal",
            result: { kind: "cancelled" },
            event: { kind: "attempt.outcome", data: {} },
            leaseToken: lease.token,
          }),
        // A late cleanup result.
        () =>
          store.recordAttemptResult({
            attemptId: attempt.attemptId,
            result: { kind: "cleanup", removed: true },
            leaseToken: lease.token,
          }),
        // A late retry decision.
        () =>
          store.createAttempt({
            runId: run.runId,
            requestId: "r-retry",
            intent: { kind: "clarification-retry" },
            origin: "coordinator-retry",
            leaseToken: lease.token,
          }),
      ];
      for (const write of late) throws(write, (error) => error.code === "lease_expired");

      // None of them landed.
      const after = store.getAttempt(attempt.attemptId);
      strictEqual(after.state, "active");
      strictEqual(after.result, null);
      strictEqual(store.listAttempts(run.runId).length, 1);
    });
  });

  it("a superseded generation stays fenced even after the newer lease itself expires", async () => {
    await withRig(async ({ controller, clock }) => {
      const { store } = controller();
      const { run } = store.createRun({ issueId: String(ISSUE), requestId: "r-1" });
      const first = store.acquireLease({ runId: run.runId, owner: "controller-a" }).lease;
      clock.tick(DEFAULT_LEASE_TTL_MS + 1);
      const second = store.acquireLease({ runId: run.runId, owner: "controller-b" }).lease;
      clock.tick(DEFAULT_LEASE_TTL_MS + 1);

      // Generation 1 is told it is fenced, not merely expired — and it can
      // neither renew nor write.
      throws(
        () => store.renewLease({ runId: run.runId, token: first.token }),
        (error) => error.code === "lease_not_held",
      );
      throws(
        () =>
          store.appendEvent({
            runId: run.runId,
            kind: "late.write",
            data: {},
            leaseToken: first.token,
          }),
        (error) => error.code === "lease_not_held",
      );
      strictEqual(second.generation, 2);
      strictEqual(ledger(store, run.runId).length, 0);
    });
  });

  it("expiry permits reconciliation, never adoption by the old token, and claims no death", async () => {
    await withRig(async ({ controller, clock, sessions }) => {
      const { coordinator } = controller();
      const { run } = await coordinator.start(startArgs("start-1"));
      clock.tick(DEFAULT_LEASE_TTL_MS + 1);

      // The read model reports the arithmetic — expired — and nothing about
      // whether the holder is alive.
      const lease = coordinator.getLease(run.runId);
      strictEqual(lease.expired, true);
      deepStrictEqual(Object.keys(lease).sort(), [
        "acquiredAt",
        "expired",
        "expiresAt",
        "generation",
        "owner",
      ]);

      // Reconciliation is lease-free and allowed; it concludes nothing.
      const reconciling = coordinator.beginReconciliation({ runId: run.runId });
      strictEqual(reconciling.state, "reconciling");
      // Adoption is an explicit fresh generation, never the old one revived.
      const adopted = coordinator.acquireLease({ runId: run.runId, owner: "controller-b" });
      strictEqual(adopted.lease.generation, 2);
      strictEqual(sessions.starts.length, 1);
    });
  });
});

describe("Factory 07 injection: dispatch crash points", () => {
  it("before the durable dispatch intent: nothing is dispatched, and a later start dispatches once", async () => {
    await withRig(async ({ controller, clock, sessions }) => {
      const crashed = controller();
      crashed.faults.arm("createAttempt");
      await rejects(
        () => crashed.coordinator.start(startArgs("start-1")),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(sessions.starts.length, 0);
      const [run] = crashed.store.listRuns();
      strictEqual(crashed.store.listAttempts(run.runId).length, 0);
      crashed.store.close();

      // The restarted controller replays the same request. The dead
      // controller's lease still stands — refused busy, never adopted early.
      const restarted = controller();
      await rejects(
        () => restarted.coordinator.start(startArgs("start-1")),
        (error) => error.code === "busy",
      );
      strictEqual(sessions.starts.length, 0);

      // Once it expires, non-dispatch is proven by the record (no attempt
      // exists): the start goes ahead, exactly once.
      clock.tick(DEFAULT_LEASE_TTL_MS + 1);
      const answer = await restarted.coordinator.start(startArgs("start-1"));
      strictEqual(answer.started, true);
      strictEqual(answer.run.runId, run.runId);
      strictEqual(sessions.starts.length, 1);
      strictEqual(restarted.store.listRuns().length, 1);
    });
  });

  it("after the durable intent, before dispatch: the attempt is never blindly replayed", async () => {
    await withRig(async ({ controller, sessions }) => {
      const crashed = controller();
      // The intent commits, then the controller dies on its next write.
      crashed.faults.arm("appendEvent", ({ kind }) => kind === "attempt.recorded");
      await rejects(
        () => crashed.coordinator.start(startArgs("start-1")),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(sessions.starts.length, 0);
      const [run] = crashed.store.listRuns();
      const [attempt] = crashed.store.listAttempts(run.runId);
      deepStrictEqual(attempt.dispatchIntent.revision, { ...REVISION });
      crashed.store.close();

      // Whether the dispatch happened is not provable from here, so the
      // replay answers from the record and dispatches nothing.
      const restarted = controller();
      const replay = await restarted.coordinator.start(startArgs("start-1"));
      strictEqual(replay.started, false);
      strictEqual(replay.attempt.attemptId, attempt.attemptId);
      strictEqual(sessions.starts.length, 0);
      // No false completion: the attempt claims no outcome, and the one
      // coordinator retry has no recorded non-dispatch evidence to fire on.
      strictEqual(restarted.store.getAttempt(attempt.attemptId).result, null);
      throws(
        () =>
          restarted.coordinator.requestCoordinatorRetry({
            runId: run.runId,
            fromAttemptId: attempt.attemptId,
            requestId: "retry-1",
            intent: {},
          }),
        (error) => error.code === "retry_not_eligible",
      );
      strictEqual(restarted.store.listAttempts(run.runId).length, 1);
    });
  });

  it("after dispatch, before the ack: the restarted controller dispatches nothing and claims nothing", async () => {
    await withRig(async ({ controller, sessions }) => {
      const crashed = controller();
      sessions.mode = "hold";
      // The start is in flight at the runtime when the controller dies.
      void crashed.coordinator.start(startArgs("start-1"));
      await settle();
      strictEqual(sessions.starts.length, 1);
      const [run] = crashed.store.listRuns();
      const [attempt] = crashed.store.listAttempts(run.runId);
      crashed.store.close();

      sessions.mode = "ack";
      const restarted = controller();
      const replay = await restarted.coordinator.start(startArgs("start-1"));
      strictEqual(replay.started, false);
      strictEqual(sessions.starts.length, 1);
      // The runtime the dead controller dispatched is not this process's to
      // drive: typed unavailable, never a silent re-dispatch.
      throws(
        () =>
          restarted.coordinator.sendPrompt({
            runId: run.runId,
            attemptId: attempt.attemptId,
            requestId: "prompt-1",
            text: "hello?",
          }),
        (error) => error.code === "conversation_unavailable",
      );
      deepStrictEqual(
        restarted.coordinator.conversationState({ runId: run.runId, attemptId: attempt.attemptId }),
        { available: false },
      );
      // The loss is recorded as uncertainty, not a completion.
      const { attempt: dead } = restarted.coordinator.recordProcessDeath({
        runId: run.runId,
        attemptId: attempt.attemptId,
        exit: null,
      });
      strictEqual(dead.state, "unknown");
      deepStrictEqual(dead.result.uncertainty, ["runtime-exit", "descendant-termination"]);
    });
  });

  it("a prompt crash before its durable intent never reaches the runtime", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, faults, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      const [session] = sessions.sessions;
      faults.arm("appendEvent", ({ kind }) => kind === "conversation.prompt");
      throws(
        () =>
          coordinator.sendPrompt({
            runId: run.runId,
            attemptId: attempt.attemptId,
            requestId: "prompt-1",
            text: "what is the scope?",
          }),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(session.prompts.length, 0);
      ok(!ledger(store, run.runId).includes("conversation.prompt"));
    });
  });

  it("a prompt whose intent is durable is never sent twice, even across a restart", async () => {
    await withRig(async ({ controller, sessions }) => {
      const first = controller();
      const { run, attempt } = await first.coordinator.start(startArgs("start-1"));
      const [session] = sessions.sessions;
      const command = {
        runId: run.runId,
        attemptId: attempt.attemptId,
        requestId: "prompt-1",
        text: "what is the scope?",
      };
      deepStrictEqual(first.coordinator.sendPrompt(command), { sent: true, requestId: "prompt-1" });
      // The same submission replayed — to this controller, then to a
      // restarted one — is answered from the ledger.
      deepStrictEqual(first.coordinator.sendPrompt(command), {
        sent: false,
        requestId: "prompt-1",
      });
      const restarted = controller();
      deepStrictEqual(restarted.coordinator.sendPrompt(command), {
        sent: false,
        requestId: "prompt-1",
      });
      strictEqual(session.prompts.length, 1);
    });
  });
});

describe("Factory 07 injection: lost acks", () => {
  it("a start answer lost on the way to the client is recovered by replay, not re-dispatch", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator } = controller();
      const lost = await coordinator.start(startArgs("start-1"));
      // The client never saw `lost`; its reconnect resubmits the request.
      const recovered = await coordinator.start(startArgs("start-1"));
      deepStrictEqual(
        { run: recovered.run.runId, attempt: recovered.attempt.attemptId },
        { run: lost.run.runId, attempt: lost.attempt.attemptId },
      );
      strictEqual(sessions.starts.length, 1);
    });
  });

  it("a runtime acceptance that fails lands as typed failure evidence, never a completion", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      const [session] = sessions.sessions;
      const command = {
        runId: run.runId,
        attemptId: attempt.attemptId,
        requestId: "prompt-1",
        text: "what is the scope?",
      };
      coordinator.sendPrompt(command);
      session.prompts[0].accepted.reject(
        Object.assign(new Error("no ack within the window"), { code: "ack_timeout" }),
      );
      session.prompts[0].settled.reject(new Error("never settled"));
      await settle();

      const failure = store
        .readEvents({ runId: run.runId, afterCursor: 0 })
        .events.map(({ event }) => event)
        .find((event) => event.kind === "conversation.prompt-failed");
      deepStrictEqual(failure.data, {
        attemptId: attempt.attemptId,
        requestId: "prompt-1",
        code: "ack_timeout",
      });
      // The uncertain prompt is not resent by a replay, and nothing closed.
      deepStrictEqual(coordinator.sendPrompt(command), { sent: false, requestId: "prompt-1" });
      strictEqual(session.prompts.length, 1);
      strictEqual(store.getAttempt(attempt.attemptId).state, "active");
      strictEqual(store.getRun(run.runId).state, "active");
    });
  });

  it("an ack that never arrives claims nothing at all", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      coordinator.sendPrompt({
        runId: run.runId,
        attemptId: attempt.attemptId,
        requestId: "prompt-1",
        text: "what is the scope?",
      });
      await settle();
      strictEqual(sessions.sessions[0].prompts.length, 1);
      const kinds = ledger(store, run.runId);
      ok(!kinds.some((kind) => kind.includes("terminal") || kind.endsWith("-failed")));
      strictEqual(store.getAttempt(attempt.attemptId).state, "active");
    });
  });

  it("a publication answer lost after the write is recovered by replay, never a second write", async () => {
    await withRig(async ({ controller, tracker }) => {
      const { coordinator } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      await coordinator.saveDraft({ runId: run.runId, attemptId: attempt.attemptId, draft: DRAFT });
      const args = approveArgs({ runId: run.runId, attemptId: attempt.attemptId });
      const lost = await coordinator.approvePublication(args);
      strictEqual(lost.published, true);
      const recovered = await coordinator.approvePublication(args);
      strictEqual(recovered.replayed, true);
      strictEqual(recovered.published, true);
      strictEqual(tracker.writes.length, 1);
    });
  });
});

describe("Factory 07 injection: descendant termination", () => {
  // This tier spawns no processes: the managed runtime and its descendants
  // live behind the session port. What exists here is the structural
  // guarantee — a runtime death is recorded with the descendants' fate as
  // explicit uncertainty, and nothing can conclude it terminal except a
  // reconciliation that cites the evidence it inspected.
  it("an observed runtime exit proves the runtime's death, never its descendants'", async () => {
    await withRig(async ({ controller }) => {
      const { coordinator } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      const { attempt: dead, run: deadRun } = coordinator.recordProcessDeath({
        runId: run.runId,
        attemptId: attempt.attemptId,
        exit: 137,
      });
      deepStrictEqual(dead.result.proof, { runtimeExit: 137 });
      deepStrictEqual(dead.result.uncertainty, ["descendant-termination"]);
      strictEqual(dead.state, "unknown");
      strictEqual(deadRun.state, "unknown");
    });
  });

  it("descendant uncertainty concludes terminal only with a cited basis, and never retries", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 137 });
      // A second death report cannot overwrite the first evidence.
      throws(
        () =>
          coordinator.recordProcessDeath({
            runId: run.runId,
            attemptId: attempt.attemptId,
            exit: 0,
          }),
        (error) => error.code === "illegal_transition",
      );
      strictEqual(store.getAttempt(attempt.attemptId).result.proof.runtimeExit, 137);
      // The unknown run dispatches nothing.
      await rejects(
        () => coordinator.start(startArgs("start-2")),
        (error) => error.code === "busy",
      );
      throws(
        () =>
          coordinator.requestCoordinatorRetry({
            runId: run.runId,
            fromAttemptId: attempt.attemptId,
            requestId: "retry-1",
            intent: {},
          }),
        (error) => error.code === "run_not_active",
      );

      coordinator.beginAttemptReconciliation({ attemptId: attempt.attemptId });
      throws(
        () =>
          coordinator.resolveAttemptReconciliation({
            attemptId: attempt.attemptId,
            to: "terminal",
          }),
        (error) => error.code === "basis_required",
      );
      strictEqual(store.getAttempt(attempt.attemptId).state, "reconciling");
      const resolved = coordinator.resolveAttemptReconciliation({
        attemptId: attempt.attemptId,
        to: "terminal",
        basis: "process group inspected: no surviving descendants",
      });
      strictEqual(resolved.state, "terminal");
      strictEqual(sessions.starts.length, 1);
    });
  });
});

describe("Factory 07 injection: restarts", () => {
  it("the record survives a restart intact; the conversation is honestly unavailable", async () => {
    await withRig(async ({ controller, sessions }) => {
      const first = controller();
      const { run, attempt } = await first.coordinator.start(startArgs("start-1"));
      const before = first.store.readEvents({ runId: run.runId, afterCursor: 0 });
      first.store.close();

      const restarted = controller();
      const section = await restarted.coordinator.runSection({ runId: run.runId });
      strictEqual(section.run.state, "active");
      strictEqual(section.attempts[0].attemptId, attempt.attemptId);
      strictEqual(section.latestCursor, before.latestCursor);
      deepStrictEqual(
        section.events.map(({ cursor }) => cursor),
        before.events.map(({ cursor }) => cursor),
      );
      deepStrictEqual(
        restarted.coordinator.conversationState({ runId: run.runId, attemptId: attempt.attemptId }),
        { available: false },
      );
      // Restarting dispatched nothing.
      strictEqual(sessions.starts.length, 1);
    });
  });

  it("the restarted controller writes only after the dead one's lease expires, on a new generation", async () => {
    await withRig(async ({ controller, clock }) => {
      const first = controller();
      const { run, attempt } = await first.coordinator.start(startArgs("start-1"));
      first.store.close();

      const restarted = controller();
      await rejects(
        () =>
          restarted.coordinator.saveDraft({
            runId: run.runId,
            attemptId: attempt.attemptId,
            draft: DRAFT,
          }),
        (error) => error.code === "busy",
      );
      strictEqual(restarted.store.getDraft(attempt.attemptId), null);

      clock.tick(DEFAULT_LEASE_TTL_MS + 1);
      await restarted.coordinator.saveDraft({
        runId: run.runId,
        attemptId: attempt.attemptId,
        draft: DRAFT,
      });
      strictEqual(restarted.coordinator.getLease(run.runId).generation, 2);
      ok(restarted.store.getDraft(attempt.attemptId));
    });
  });

  it("the event cursor continues across a restart; nothing is renumbered", async () => {
    await withRig(async ({ controller, clock }) => {
      const first = controller();
      const { run } = await first.coordinator.start(startArgs("start-1"));
      const { latestCursor } = first.store.readEvents({ runId: run.runId, afterCursor: 0 });
      first.store.close();

      clock.tick(DEFAULT_LEASE_TTL_MS + 1);
      const restarted = controller();
      restarted.coordinator.beginReconciliation({ runId: run.runId });
      const after = restarted.store.readEvents({ runId: run.runId, afterCursor: latestCursor });
      deepStrictEqual(
        after.events.map(({ cursor }) => cursor),
        [latestCursor + 1],
      );
    });
  });
});

describe("Factory 07 injection: storage failures", () => {
  it("a failed run write refuses the start typed and dispatches nothing", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, faults, store } = controller();
      faults.arm("createRun");
      await rejects(
        () => coordinator.start(startArgs("start-1")),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(sessions.starts.length, 0);
      deepStrictEqual(store.listRuns(), []);
    });
  });

  it("a failed lease write refuses the start typed and dispatches nothing", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, faults } = controller();
      faults.arm("acquireLease");
      await rejects(
        () => coordinator.start(startArgs("start-1")),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(sessions.starts.length, 0);
    });
  });

  it("a failed denial record surfaces typed; the attempt never reads as an outcome it lacks", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, faults, store } = controller();
      sessions.mode = "deny";
      faults.arm("recordAttemptResult");
      await rejects(
        () => coordinator.start(startArgs("start-1")),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      const [run] = store.listRuns();
      const [attempt] = store.listAttempts(run.runId);
      strictEqual(attempt.result, null);
      strictEqual(attempt.state, "active");
      // Without the recorded denial there is no non-dispatch proof: the
      // coordinator retry stays shut.
      throws(
        () =>
          coordinator.requestCoordinatorRetry({
            runId: run.runId,
            fromAttemptId: attempt.attemptId,
            requestId: "retry-1",
            intent: {},
          }),
        (error) => error.code === "retry_not_eligible",
      );
    });
  });

  it("a failed outcome write leaves the attempt, budget, and loop counter untouched", async () => {
    await withRig(async ({ controller }) => {
      const { coordinator, faults, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      faults.arm("recordAttemptOutcome");
      throws(
        () =>
          coordinator.recordOutcome({
            runId: run.runId,
            attemptId: attempt.attemptId,
            outcome: { kind: "provider-failure", reason: "quota", usage: { total: 7 } },
          }),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(store.getAttempt(attempt.attemptId).state, "active");
      strictEqual(store.getAttempt(attempt.attemptId).result, null);
      deepStrictEqual(store.usageBudgetFor(run.runId).lines, []);
      ok(!ledger(store, run.runId).includes("attempt.outcome"));
    });
  });

  it("a failed budget write after a committed outcome surfaces; the outcome stays evidence", async () => {
    await withRig(async ({ controller }) => {
      const { coordinator, faults, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      faults.arm("appendUsageLines");
      throws(
        () =>
          coordinator.recordOutcome({
            runId: run.runId,
            attemptId: attempt.attemptId,
            outcome: { kind: "provider-failure", reason: "quota", usage: { total: 7 } },
          }),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(store.getAttempt(attempt.attemptId).state, "awaiting-human");
      deepStrictEqual(store.usageBudgetFor(run.runId).lines, []);
    });
  });

  it("a failed draft write refuses the save typed and records no save evidence", async () => {
    await withRig(async ({ controller }) => {
      const { coordinator, faults, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      faults.arm("saveDraft");
      await rejects(
        () =>
          coordinator.saveDraft({ runId: run.runId, attemptId: attempt.attemptId, draft: DRAFT }),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(store.getDraft(attempt.attemptId), null);
      ok(!ledger(store, run.runId).includes("draft.saved"));
    });
  });

  it("a failed approval binding or nonce spend blocks the tracker write", async () => {
    await withRig(async ({ controller, tracker }) => {
      const { coordinator, faults, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      await coordinator.saveDraft({ runId: run.runId, attemptId: attempt.attemptId, draft: DRAFT });

      faults.arm("recordApproval");
      await rejects(
        () =>
          coordinator.approvePublication(
            approveArgs({ runId: run.runId, attemptId: attempt.attemptId }, "approve-1"),
          ),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      faults.disarm("recordApproval");
      faults.arm("consumeApproval");
      await rejects(
        () =>
          coordinator.approvePublication(
            approveArgs({ runId: run.runId, attemptId: attempt.attemptId }, "approve-2"),
          ),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(tracker.writes.length, 0);
      strictEqual(store.getAttempt(attempt.attemptId).state, "active");
    });
  });

  it("a failed outcome write after the tracker write never claims success, and never writes twice", async () => {
    await withRig(async ({ controller, tracker }) => {
      const { coordinator, faults, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      await coordinator.saveDraft({ runId: run.runId, attemptId: attempt.attemptId, draft: DRAFT });
      const args = approveArgs({ runId: run.runId, attemptId: attempt.attemptId });
      faults.arm("recordAttemptOutcome");
      await rejects(
        () => coordinator.approvePublication(args),
        (error) => error.code === "ERR_SQLITE_ERROR",
      );
      strictEqual(tracker.writes.length, 1);
      faults.disarm("recordAttemptOutcome");

      // The nonce was spent before the write, durably: the replay cannot
      // write again, and it claims no publication the record cannot prove.
      const replay = await coordinator.approvePublication(args);
      strictEqual(replay.replayed, true);
      strictEqual(replay.published, false);
      strictEqual(replay.approval.status, "consumed");
      strictEqual(tracker.writes.length, 1);
      strictEqual(store.getAttempt(attempt.attemptId).state, "active");
      strictEqual(store.getRun(run.runId).state, "active");
    });
  });

  it("a ledger that refuses a runtime frame stops the pump with evidence, never a crash", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, faults, store } = controller();
      const { run } = await coordinator.start(startArgs("start-1"));
      const [session] = sessions.sessions;
      const unhandled = await collectingUnhandled(async () => {
        faults.arm("appendEvents", ({ events }) => events[0]?.type === "conversation");
        session.emit({ type: "message_update", text: "lost?" });
        await settle();
      });
      deepStrictEqual(unhandled, []);
      // The frame was never durable, so no viewer was served it; the pump's
      // end is recorded as typed evidence.
      const events = store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
      ok(!events.some(({ event }) => event.type === "conversation"));
      const failed = events.find(({ event }) => event.kind === "conversation.stream-failed");
      strictEqual(failed.event.data.code, "ERR_SQLITE_ERROR");
    });
  });

  it("a ledger that refuses everything leaves the evidence paths silent, never crashing", async () => {
    await withRig(async ({ controller, sessions }) => {
      const { coordinator, faults, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      const [session] = sessions.sessions;
      coordinator.sendPrompt({
        runId: run.runId,
        attemptId: attempt.attemptId,
        requestId: "prompt-1",
        text: "what is the scope?",
      });
      const before = ledger(store, run.runId);
      const unhandled = await collectingUnhandled(async () => {
        // The disk is gone for every append: the frame, the pump's failure
        // record, and the lost ack's failure record all refuse.
        faults.arm("appendEvents");
        session.emit({ type: "message_update", text: "lost?" });
        session.prompts[0].accepted.reject(
          Object.assign(new Error("no ack"), { code: "ack_timeout" }),
        );
        session.prompts[0].settled.reject(new Error("never settled"));
        await settle();
      });
      deepStrictEqual(unhandled, []);
      // Nothing undurable was presented as evidence, and nothing closed.
      deepStrictEqual(ledger(store, run.runId), before);
      strictEqual(store.getAttempt(attempt.attemptId).state, "active");
    });
  });
});

describe("Factory 07 injection: cursor gaps", () => {
  it("an expired cursor reports the explicit gap; retained events are never invented", async () => {
    await withRig(
      async ({ controller }) => {
        const { coordinator, store } = controller();
        const { run, attempt } = await coordinator.start(startArgs("start-1"));
        for (let index = 0; index < 5; index += 1)
          coordinator.publish({
            runId: run.runId,
            event: { type: "operational", kind: "note", data: { index }, at: "t" },
          });
        const { latestCursor } = store.readEvents({ runId: run.runId, afterCursor: 0 });
        const firstRetainedCursor = latestCursor - 2;

        const observed = coordinator.observe({ runId: run.runId, afterCursor: 0 });
        deepStrictEqual(observed.gap, { after: 0, firstRetainedCursor });
        deepStrictEqual(
          observed.events.map(({ cursor }) => cursor),
          [firstRetainedCursor, firstRetainedCursor + 1, latestCursor],
        );
        const section = await coordinator.runSection({ runId: run.runId, afterCursor: 1 });
        deepStrictEqual(section.gap, { after: 1, firstRetainedCursor });

        // The live stream opens with the gap frame before any event.
        const { stream } = coordinator.streamEvents({
          runId: run.runId,
          attemptId: attempt.attemptId,
          afterCursor: 0,
        });
        const opening = await stream.next();
        deepStrictEqual(opening.value.gap, { after: 0, firstRetainedCursor });
        await stream.return();

        // A cursor at the retained edge has no gap; one past the end is a
        // claim on history never written.
        strictEqual(
          coordinator.observe({ runId: run.runId, afterCursor: firstRetainedCursor - 1 }).gap,
          undefined,
        );
        throws(
          () => coordinator.observe({ runId: run.runId, afterCursor: latestCursor + 1 }),
          (error) => error.code === "invalid_cursor",
        );
      },
      { eventLedgerLimit: 3 },
    );
  });
});

describe("Factory 07 injection: cleanup races", () => {
  // Parks a started run in quarantine through the recovery path, leaving
  // the live session's handle and lease with the controller.
  const quarantined = async (coordinator) => {
    const started = await coordinator.start(startArgs("start-1"));
    const { run, attempt } = started;
    coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    coordinator.beginAttemptReconciliation({ attemptId: attempt.attemptId });
    coordinator.resolveAttemptReconciliation({ attemptId: attempt.attemptId, to: "quarantined" });
    coordinator.beginReconciliation({ runId: run.runId });
    coordinator.resolveReconciliation({ runId: run.runId, to: "quarantined" });
    return started;
  };

  it("discard and reconciliation race to one winner; the loser is typed", async () => {
    await withRig(async ({ controller }) => {
      const a = controller();
      const b = controller();
      const { run } = await quarantined(a.coordinator);
      a.coordinator.discardRunEvidence({ runId: run.runId, confirmation: run.runId });
      // The other controller's reconciliation and a second discard both
      // lose to the committed discard.
      throws(
        () => b.coordinator.beginReconciliation({ runId: run.runId }),
        (error) => error.code === "illegal_transition",
      );
      throws(
        () => b.coordinator.discardRunEvidence({ runId: run.runId, confirmation: run.runId }),
        (error) => error.code === "illegal_transition",
      );
      strictEqual(b.store.getRun(run.runId).state, "terminal");
    });
  });

  it("a live run is never a discard target, whoever asks", async () => {
    await withRig(async ({ controller }) => {
      const a = controller();
      const b = controller();
      const { run } = await a.coordinator.start(startArgs("start-1"));
      throws(
        () => b.coordinator.discardRunEvidence({ runId: run.runId, confirmation: run.runId }),
        (error) => error.code === "illegal_transition",
      );
      ok(ledger(a.store, run.runId).length > 0);
    });
  });

  it("a matching database path or a lookalike identity never authorizes deletion", async () => {
    await withRig(async ({ controller, databasePath }) => {
      const owner = controller();
      const { run } = await quarantined(owner.coordinator);
      const evidence = ledger(owner.store, run.runId);

      // Same database file, another host repo: the path matches, the
      // ownership does not — the record is invisible, not deletable.
      const foreign = controller({ hostRepo: "someone-else/workbench" });
      throws(
        () => foreign.coordinator.discardRunEvidence({ runId: run.runId, confirmation: run.runId }),
        (error) => error.code === "run_not_found",
      );
      // Anything but the record's own identity confirms nothing — not
      // another run's id, not the issue, not the database path.
      for (const confirmation of ["run_other", String(ISSUE), databasePath, undefined])
        throws(
          () => owner.coordinator.discardRunEvidence({ runId: run.runId, confirmation }),
          (error) => error.code === "discard_unconfirmed",
        );
      deepStrictEqual(ledger(owner.store, run.runId), evidence);
      strictEqual(owner.store.getRun(run.runId).state, "quarantined");
    });
  });
});

describe("Factory 07 injection: retained evidence", () => {
  it("retained evidence survives restarts, stays readable without a lease, and is never auto-cleaned", async () => {
    await withRig(async ({ controller, clock }) => {
      const first = controller();
      const { run, attempt } = await first.coordinator.start(startArgs("start-1"));
      first.coordinator.recordProcessDeath({
        runId: run.runId,
        attemptId: attempt.attemptId,
        exit: 143,
      });
      const evidence = first.store.readEvents({ runId: run.runId, afterCursor: 0 }).events;
      first.store.close();

      // Restarts and lease expiry are not cleanup triggers.
      clock.tick(10 * DEFAULT_LEASE_TTL_MS);
      const restarted = controller();
      const observed = restarted.coordinator.observe({ runId: run.runId, afterCursor: 0 });
      deepStrictEqual(observed.events, evidence);
      strictEqual(observed.snapshot.run.state, "unknown");
      strictEqual(observed.snapshot.attempts[0].state, "unknown");
      deepStrictEqual(restarted.store.getAttempt(attempt.attemptId).result.proof, {
        runtimeExit: 143,
      });
      strictEqual(restarted.coordinator.getLease(run.runId).expired, true);
    });
  });

  it("the only destruction is the typed discard, and the record stays honest after it", async () => {
    await withRig(async ({ controller }) => {
      const { coordinator, store } = controller();
      const { run, attempt } = await coordinator.start(startArgs("start-1"));
      coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: 143 });
      const discarded = coordinator.discardRunEvidence({
        runId: run.runId,
        confirmation: run.runId,
      });
      strictEqual(discarded.state, "terminal");
      ok(discarded.discardedAt);
      // The attempt row survives as a record with its termination evidence:
      // a discard is not a completion — the attempt never reads terminal.
      const survivor = store.getAttempt(attempt.attemptId);
      strictEqual(survivor.state, "unknown");
      deepStrictEqual(survivor.result.uncertainty, ["descendant-termination"]);
      const section = await coordinator.runSection({ runId: run.runId });
      deepStrictEqual(section.events, []);
      strictEqual(section.run.discardedAt, discarded.discardedAt);
    });
  });
});
