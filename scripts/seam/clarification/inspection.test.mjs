import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createClarificationCoordinator } from "./coordinator.mjs";
import { openClarificationStore } from "./store.mjs";

// The inspection half of the clarification coordinator (spec #221, ticket
// #237, Factory 11): the reads the display projection needs beyond the run
// section — run states for In flight, lease/usage/escalations/readiness —
// and the action matrix's run-level acts: cancel attempt, retain evidence,
// the typed destructive discard, and retry as a fresh attempt. Real SQLite
// on a temp directory, fake tracker and session ports, a fixed clock.

const REVISION = { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" };

const collectedIssue = (number = 230) => ({
  repo: "example/project",
  issue: { number, title: "Clarification 16", body: "the body", state: "OPEN" },
  revision: REVISION,
  issueProvenance: { source: "tracker", locator: `example/project#${number}` },
  blockers: [],
  warnings: [],
  capped: false,
  failed: false,
});

// A tracker port that records every call. Run inspection and every run
// action may only READ the tracker: no issue-body write, and no other
// method at all — a workflow phase is GitHub's label, and nothing here
// can reach for one (the phase fence below).
const recordingTracker = ({ fail = false } = {}) => {
  const calls = [];
  const port = {
    readContext: async ({ issueNumber }) => {
      calls.push(["readContext", issueNumber]);
      if (fail) throw new Error("tracker down");
      return collectedIssue(issueNumber);
    },
    updateIssueBody: async (args) => {
      calls.push(["updateIssueBody", args]);
      throw new Error("inspection never writes the tracker");
    },
  };
  const tracker = new Proxy(port, {
    get(target, property) {
      if (!(property in target)) calls.push(["unexpected", String(property)]);
      return target[property];
    },
  });
  return { tracker, calls };
};

const liveSession = () => {
  const session = {
    disposed: 0,
    sendPrompt: () => ({ accepted: Promise.resolve(), settled: Promise.resolve() }),
    dispose: async () => {
      session.disposed += 1;
    },
  };
  return session;
};

const withInspection = async (fn, { trackerFails = false, denyStart = false } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-clarification-inspection-"));
  // One clock for store and coordinator; tests that need a lease to lapse
  // advance it explicitly — never a real sleep.
  let now = Date.parse("2026-09-18T00:00:00Z");
  const clock = () => new Date(now).toISOString().replace(".000Z", "Z");
  const advance = (ms) => {
    now += ms;
  };
  const store = openClarificationStore({
    hostRepo: "example/project",
    databasePath: join(directory, "runs.sqlite"),
    clock,
  });
  const { tracker, calls } = recordingTracker({ fail: trackerFails });
  const sessions = [];
  const sessionPort = {
    deny: denyStart,
    // A test hook run inside the handshake, before it acks or denies.
    during: null,
    start: async () => {
      if (sessionPort.during) await sessionPort.during();
      if (sessionPort.deny)
        throw Object.assign(new Error("no runtime here"), { code: "runtime_unconfigured" });
      const session = liveSession();
      sessions.push(session);
      return session;
    },
  };
  const coordinator = createClarificationCoordinator({
    store,
    clock,
    tracker,
    sessions: sessionPort,
    provider: "openai-codex-oauth",
    dataDestination: "https://api.openai.com",
  });
  try {
    return await fn({ coordinator, store, trackerCalls: calls, sessions, sessionPort, advance });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const start = (coordinator, issueNumber = 230, requestId = "start-1") =>
  coordinator.start({ issueNumber, requestId, revision: REVISION });

const deniedStart = async (coordinator, issueNumber = 230, requestId = "start-1") => {
  await rejects(() => start(coordinator, issueNumber, requestId), { code: "start_denied" });
  return (await coordinator.runForIssue({ issueNumber })).runId;
};

const kinds = (store, runId) =>
  store
    .readEvents({ runId, afterCursor: 0 })
    .events.filter(({ event }) => event.type === "operational")
    .map(({ event }) => event.kind);

test("run states list one row per issue — its latest run — and nothing actionable", async () => {
  await withInspection(async ({ coordinator }) => {
    const { run } = await start(coordinator, 230, "a");
    await start(coordinator, 231, "b");
    const { runs } = coordinator.listRunStates();
    deepStrictEqual(runs.map((row) => row.issueId).sort(), ["230", "231"]);
    const row = runs.find((entry) => entry.issueId === "230");
    deepStrictEqual(Object.keys(row).sort(), ["issueId", "runId", "state", "updatedAt"]);
    strictEqual(row.runId, run.runId);
    strictEqual(row.state, "active");
  });
});

test("inspection answers lease, usage, escalations and the five readiness axes", async () => {
  await withInspection(async ({ coordinator }) => {
    const { run, attempt } = await start(coordinator);
    coordinator.recordUsage({
      runId: run.runId,
      attemptId: attempt.attemptId,
      line: { kind: "unknown", unit: "subscription" },
    });
    const view = await coordinator.inspection({
      runId: run.runId,
      posture: { posture: "enabled" },
    });
    strictEqual(view.runId, run.runId);
    // Ownership and expiry arithmetic only — never the token.
    strictEqual(view.lease.owner, "workbench-clarification-coordinator");
    strictEqual("token" in view.lease, false);
    strictEqual(view.usage.totals.unknownLines, 1);
    strictEqual(view.usage.lines[0].value, null);
    deepStrictEqual(view.escalations, []);
    deepStrictEqual(
      view.readiness.axes.map(({ axis, verdict }) => [axis, verdict]),
      [
        ["tracker-eligibility", "ready"],
        ["brief-completeness", "needs-information"],
        ["host-capability", "ready"],
        ["research-sufficiency", "needs-information"],
        ["authorization", "ready"],
      ],
    );
  });
});

test("a failed tracker read withholds the tracker axis as unknown, never ready", async () => {
  await withInspection(
    async ({ coordinator, store }) => {
      const { run } = store.createRun({ issueId: "230", requestId: "r" });
      const view = await coordinator.inspection({ runId: run.runId, posture: null });
      const tracker = view.readiness.axes.find((axis) => axis.axis === "tracker-eligibility");
      strictEqual(tracker.verdict, "unknown");
      ok(tracker.reasons[0].includes("tracker down"));
      strictEqual(view.lease, null);
    },
    { trackerFails: true },
  );
});

test("cancel attempt closes a live attempt as a cancellation, once", async () => {
  await withInspection(async ({ coordinator, store, sessions }) => {
    const { run, attempt } = await start(coordinator);
    const action = { kind: "cancel-attempt", attemptId: attempt.attemptId };
    const first = await coordinator.runAction({ runId: run.runId, requestId: "c1", action });
    strictEqual(first.done, true);
    strictEqual(sessions[0].disposed, 1);
    strictEqual(store.getAttempt(attempt.attemptId).state, "terminal");
    const outcome = store
      .readEvents({ runId: run.runId, afterCursor: 0 })
      .events.find(({ event }) => event.kind === "attempt.outcome");
    strictEqual(outcome.event.data.classification, "cancellation");
    ok(kinds(store, run.runId).includes("attempt.cancelled"));

    // The replay answers from the record and cancels nothing twice.
    const replay = await coordinator.runAction({ runId: run.runId, requestId: "c1", action });
    strictEqual(replay.done, false);
    strictEqual(sessions[0].disposed, 1);
  });
});

test("cancel refuses an attempt whose outcome is uncertain — that reconciles", async () => {
  await withInspection(async ({ coordinator, store }) => {
    const { run, attempt } = await start(coordinator);
    coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    await rejects(
      () =>
        coordinator.runAction({
          runId: run.runId,
          requestId: "c1",
          action: { kind: "cancel-attempt", attemptId: attempt.attemptId },
        }),
      { code: "attempt_not_active" },
    );
    strictEqual(store.getAttempt(attempt.attemptId).state, "unknown");
  });
});

test("retain evidence records the decision and moves nothing", async () => {
  await withInspection(
    async ({ coordinator, store }) => {
      const runId = await deniedStart(coordinator);
      const answer = await coordinator.runAction({
        runId,
        requestId: "keep-1",
        action: { kind: "retain-evidence" },
      });
      strictEqual(answer.done, true);
      strictEqual(answer.run.state, "awaiting-human");
      ok(kinds(store, runId).includes("run.evidence-retained"));
      const replay = await coordinator.runAction({
        runId,
        requestId: "keep-1",
        action: { kind: "retain-evidence" },
      });
      strictEqual(replay.done, false);
    },
    { denyStart: true },
  );
});

test("retain evidence refuses a live run — there is nothing to decide yet", async () => {
  await withInspection(async ({ coordinator }) => {
    const { run } = await start(coordinator);
    await rejects(
      () =>
        coordinator.runAction({
          runId: run.runId,
          requestId: "keep-1",
          action: { kind: "retain-evidence" },
        }),
      { code: "illegal_transition" },
    );
  });
});

test("discard is typed-confirmed: anything but the run id destroys nothing", async () => {
  await withInspection(
    async ({ coordinator, store }) => {
      const runId = await deniedStart(coordinator);
      await rejects(
        () =>
          coordinator.runAction({
            runId,
            requestId: "d1",
            action: { kind: "discard-evidence", confirmation: "yes" },
          }),
        { code: "discard_unconfirmed" },
      );
      ok(kinds(store, runId).length > 0);

      const answer = await coordinator.runAction({
        runId,
        requestId: "d2",
        action: { kind: "discard-evidence", confirmation: runId },
      });
      strictEqual(answer.done, true);
      strictEqual(answer.run.state, "terminal");
      strictEqual(answer.run.discardedAt, "2026-09-18T00:00:00Z");
      deepStrictEqual(kinds(store, runId), []);
      const replay = await coordinator.runAction({
        runId,
        requestId: "d2",
        action: { kind: "discard-evidence", confirmation: runId },
      });
      strictEqual(replay.done, false);
    },
    { denyStart: true },
  );
});

test("retry is a fresh attempt on the re-rendered manifest's revision", async () => {
  await withInspection(
    async ({ coordinator, store, sessionPort, sessions }) => {
      const runId = await deniedStart(coordinator);
      strictEqual(store.getRun(runId).state, "awaiting-human");

      // A drifted revision is the stale manifest's typed rejection.
      await rejects(
        () =>
          coordinator.runAction({
            runId,
            requestId: "retry-1",
            action: { kind: "retry", revision: { ...REVISION, bodyHash: "sha-256:moved" } },
          }),
        { code: "manifest_stale" },
      );

      sessionPort.deny = false;
      const answer = await coordinator.runAction({
        runId,
        requestId: "retry-1",
        action: { kind: "retry", revision: REVISION },
      });
      strictEqual(answer.done, true);
      strictEqual(answer.run.state, "active");
      strictEqual(sessions.length, 1);
      const attempts = store.listAttempts(runId);
      strictEqual(attempts.length, 2);
      const fresh = attempts.find((a) => a.attemptId === answer.attemptId);
      strictEqual(fresh.origin, "manual");
      strictEqual(fresh.state, "active");

      // A replay answers the same attempt; nothing dispatches twice.
      const replay = await coordinator.runAction({
        runId,
        requestId: "retry-1",
        action: { kind: "retry", revision: REVISION },
      });
      strictEqual(replay.done, false);
      strictEqual(replay.attemptId, answer.attemptId);
      strictEqual(sessions.length, 1);

      // With an attempt live, a second retry is busy — never a queue.
      await rejects(
        () =>
          coordinator.runAction({
            runId,
            requestId: "retry-2",
            action: { kind: "retry", revision: REVISION },
          }),
        { code: "busy" },
      );
    },
    { denyStart: true },
  );
});

test("retry refuses an Unknown run: uncertainty reconciles before anything re-dispatches", async () => {
  await withInspection(async ({ coordinator, sessions }) => {
    const { run, attempt } = await start(coordinator);
    coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    await rejects(
      () =>
        coordinator.runAction({
          runId: run.runId,
          requestId: "retry-1",
          action: { kind: "retry", revision: REVISION },
        }),
      { code: "run_not_active" },
    );
    strictEqual(sessions.length, 1);
  });
});

// The phase fence (ticket #237's "run events never move workflow phases"):
// a workflow phase is a GitHub label, and the only tracker port the
// coordinator holds reads context and writes the one approved issue body.
// Driving every inspection read and run action through a full lifecycle
// touches the tracker for reads alone — no write, no other method.
test("run inspection and every run action only ever read the tracker", async () => {
  await withInspection(
    async ({ coordinator, trackerCalls, sessionPort }) => {
      const runId = await deniedStart(coordinator);
      await coordinator.inspection({ runId, posture: { posture: "enabled" } });
      await coordinator.runAction({
        runId,
        requestId: "keep",
        action: { kind: "retain-evidence" },
      });
      sessionPort.deny = false;
      const retried = await coordinator.runAction({
        runId,
        requestId: "retry",
        action: { kind: "retry", revision: REVISION },
      });
      await coordinator.runAction({
        runId,
        requestId: "cancel",
        action: { kind: "cancel-attempt", attemptId: retried.attemptId },
      });
      coordinator.listRunStates();
      ok(trackerCalls.length > 0);
      deepStrictEqual(
        trackerCalls.filter(([method]) => method !== "readContext"),
        [],
      );
    },
    { denyStart: true },
  );
});

// --- Review defects on the run actions (ticket #237 follow-up). ---

const LEASE_TTL_PAST = 31_000;

test("concurrent retries on a parked run dispatch exactly one fresh attempt", async () => {
  await withInspection(
    async ({ coordinator, store, sessionPort, sessions }) => {
      const runId = await deniedStart(coordinator);
      sessionPort.deny = false;
      const retry = (requestId) =>
        coordinator.runAction({
          runId,
          requestId,
          action: { kind: "retry", revision: REVISION },
        });
      const results = await Promise.allSettled([retry("retry-a"), retry("retry-b")]);
      strictEqual(results.filter((r) => r.status === "fulfilled").length, 1);
      const refused = results.find((r) => r.status === "rejected");
      strictEqual(refused.reason.code, "busy");
      strictEqual(sessions.length, 1);
      strictEqual(store.listAttempts(runId).filter((a) => a.state === "active").length, 1);
    },
    { denyStart: true },
  );
});

// The crash window: an approval was consumed and no publication outcome was
// ever recorded — the write may have landed. Neither cancel nor retry may
// open a path to a second approval on top of it.
const spendApprovalWithoutOutcome = (store, runId, attemptId) => {
  const { lease } = store.acquireLease({ runId, owner: "crashed-publisher" });
  const { approval } = store.recordApproval({
    attemptId,
    binding: { bodyDigest: "sha-256:x" },
    leaseToken: lease.token,
  });
  store.consumeApproval({ nonce: approval.nonce, leaseToken: lease.token });
  return lease.token;
};

test("cancel refuses while a consumed approval has no publication outcome", async () => {
  await withInspection(async ({ coordinator, store, advance }) => {
    const { run, attempt } = await start(coordinator);
    advance(LEASE_TTL_PAST);
    spendApprovalWithoutOutcome(store, run.runId, attempt.attemptId);
    await rejects(
      () =>
        coordinator.runAction({
          runId: run.runId,
          requestId: "c1",
          action: { kind: "cancel-attempt", attemptId: attempt.attemptId },
        }),
      { code: "publication_uncertain" },
    );
    strictEqual(store.getAttempt(attempt.attemptId).state, "active");
  });
});

test("retry refuses while any attempt holds a consumed approval without an outcome", async () => {
  await withInspection(async ({ coordinator, store, advance, sessions }) => {
    const { run, attempt } = await start(coordinator);
    advance(LEASE_TTL_PAST);
    const token = spendApprovalWithoutOutcome(store, run.runId, attempt.attemptId);
    // The record a cancel would have left before the guard existed.
    store.updateAttemptState({ attemptId: attempt.attemptId, to: "terminal", leaseToken: token });
    store.updateRunState({ runId: run.runId, to: "awaiting-human", leaseToken: token });
    advance(LEASE_TTL_PAST);
    await rejects(
      () =>
        coordinator.runAction({
          runId: run.runId,
          requestId: "retry-1",
          action: { kind: "retry", revision: REVISION },
        }),
      { code: "publication_uncertain" },
    );
    strictEqual(store.listAttempts(run.runId).length, 1);
    strictEqual(sessions.length, 1);
  });
});

test("retry disposes the live session of the parked attempt it supersedes", async () => {
  await withInspection(async ({ coordinator, store, sessions }) => {
    const { run, attempt } = await start(coordinator);
    coordinator.recordOutcome({
      runId: run.runId,
      attemptId: attempt.attemptId,
      outcome: { kind: "provider-failure", reason: "quota" },
    });
    strictEqual(store.getAttempt(attempt.attemptId).state, "awaiting-human");
    await coordinator.runAction({
      runId: run.runId,
      requestId: "retry-1",
      action: { kind: "retry", revision: REVISION },
    });
    strictEqual(sessions[0].disposed, 1);
    strictEqual(sessions[1].disposed, 0);
    strictEqual(
      coordinator.conversationState({ runId: run.runId, attemptId: attempt.attemptId }).available,
      false,
    );
  });
});

test("discard disposes every live session on the run", async () => {
  await withInspection(async ({ coordinator, sessions }) => {
    const { run, attempt } = await start(coordinator);
    coordinator.recordProcessDeath({ runId: run.runId, attemptId: attempt.attemptId, exit: null });
    await coordinator.runAction({
      runId: run.runId,
      requestId: "d1",
      action: { kind: "discard-evidence", confirmation: run.runId },
    });
    strictEqual(sessions[0].disposed, 1);
    strictEqual(
      coordinator.conversationState({ runId: run.runId, attemptId: attempt.attemptId }).available,
      false,
    );
  });
});

test("a denial after a handshake longer than the lease is still a recorded start denial", async () => {
  await withInspection(
    async ({ coordinator, store, sessionPort, advance }) => {
      sessionPort.during = async () => advance(LEASE_TTL_PAST);
      await rejects(() => start(coordinator), { code: "start_denied" });
      const { runId } = await coordinator.runForIssue({ issueNumber: 230 });
      strictEqual(store.listAttempts(runId)[0].state, "terminal");
      strictEqual(store.getRun(runId).state, "awaiting-human");
    },
    { denyStart: true },
  );
});

test("an acked session whose dispatch mark cannot be recorded is disposed, never left running", async () => {
  await withInspection(async ({ coordinator, store, sessionPort, sessions, advance }) => {
    // During the handshake the lease lapses and another controller takes
    // it: the mark cannot travel under this process's lease.
    sessionPort.during = async () => {
      advance(LEASE_TTL_PAST);
      const { runId } = store.listRuns()[0];
      store.acquireLease({ runId, owner: "another-controller" });
    };
    await rejects(() => start(coordinator), { code: "dispatch_unrecorded" });
    strictEqual(sessions[0].disposed, 1);
    const { runId } = await coordinator.runForIssue({ issueNumber: 230 });
    const [attempt] = store.listAttempts(runId);
    strictEqual(attempt.dispatchedAt, undefined);
    strictEqual(attempt.state, "unknown");
    strictEqual(
      coordinator.conversationState({ runId, attemptId: attempt.attemptId }).available,
      false,
    );
  });
});
