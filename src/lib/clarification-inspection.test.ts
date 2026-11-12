import { describe, expect, it } from "vite-plus/test";

import type {
  ClarificationInspectionResult,
  ClarificationRunResult,
  WorkItemRecord,
} from "../types";
import { clarificationLifecycleStates } from "../types";
import {
  actionMatrix,
  operationalTimeline,
  ownershipFor,
  returnCardFor,
  runChipFor,
  statusAxes,
  toneClass,
} from "./clarification-inspection";
import { inFlightBuckets } from "./in-flight";

// The run inspection projection's contract (spec #221, ticket #237): panel
// per axis in each owner's vocabulary, a timeline segmented by attempt
// that references the conversation instead of repeating it, explicit gaps,
// the return card's checkpoint fields with exactly one primary action, the
// action matrix with discard as the single typed destructive act, unknown
// as the word — and no path from a run event to a workflow phase.

const envelope = (cursor: number, event: unknown) =>
  ({
    cursor,
    envelope: "clarification-events/v1",
    event,
  }) as ClarificationRunResult["events"][number];

const op = (cursor: number, kind: string, data: Record<string, unknown> = {}) =>
  envelope(cursor, { type: "operational", kind, data, at: `2026-09-18T10:00:0${cursor % 10}Z` });

const attempt = (
  attemptId: string,
  state: ClarificationRunResult["attempts"][number]["state"],
  origin: "manual" | "coordinator-retry" = "manual",
) => ({
  attemptId,
  runId: "run_1",
  hostRepo: "example/project",
  requestId: `req-${attemptId}`,
  dispatchIntent: { provider: "p", dataDestination: "d" },
  state,
  origin,
  createdAt: "2026-09-18T10:00:00.000Z",
  updatedAt: "2026-09-18T10:00:00.000Z",
});

const section = (overrides: Partial<ClarificationRunResult> = {}): ClarificationRunResult => ({
  run: {
    runId: "run_1",
    hostRepo: "example/project",
    issueId: "230",
    requestId: "start-1",
    state: "active",
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
  },
  attempts: [attempt("a1", "active")],
  latestCursor: 0,
  events: [],
  ...overrides,
});

const inspection = (
  overrides: Partial<ClarificationInspectionResult> = {},
): ClarificationInspectionResult => ({
  runId: "run_1",
  lease: {
    owner: "workbench-clarification-coordinator",
    generation: 1,
    acquiredAt: "2026-09-18T10:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    expired: false,
  },
  usage: { lines: [], totals: { reported: {}, estimated: {}, unknownLines: 0 } },
  escalations: [],
  readiness: {
    axes: [
      { axis: "tracker-eligibility", verdict: "ready", reasons: [] },
      { axis: "brief-completeness", verdict: "needs-information", reasons: ["no draft"] },
      { axis: "host-capability", verdict: "ready", reasons: [] },
      { axis: "research-sufficiency", verdict: "unknown", reasons: [] },
      { axis: "authorization", verdict: "unsupported", reasons: [] },
    ],
  },
  ...overrides,
});

const NOW = Date.parse("2026-09-18T10:00:10.000Z");

describe("status axes", () => {
  it("renders each axis in its owner's vocabulary, never a merged word", () => {
    const axes = statusAxes({
      section: section({ run: { ...section().run, state: "awaiting-human" } }),
      conversationState: { available: true, sessionState: "waiting-for-input" },
      inspection: inspection(),
    });
    expect(axes.lifecycle.word).toBe("awaiting-human");
    expect(axes.attempts.map((line) => line.word)).toEqual(["active"]);
    expect(axes.conversation.word).toBe("waiting-for-input");
    expect(axes.readiness.map((axis) => axis.word)).toEqual([
      "ready",
      "needs-information",
      "ready",
      "unknown",
      "unsupported",
    ]);
    expect(axes.usage.map((cell) => cell.kind)).toEqual(["reported", "estimated", "unknown"]);
    // No key anywhere names a summary status across axes.
    expect(Object.keys(axes).sort()).toEqual(
      ["attempts", "conversation", "lifecycle", "readiness", "usage"].sort(),
    );
  });

  it("renders unknown as the word, with the unknown tone, wherever it is not known", () => {
    const axes = statusAxes({
      section: section({ run: { ...section().run, state: "unknown" } }),
      conversationState: null,
      inspection: null,
    });
    expect(axes.lifecycle).toMatchObject({ word: "unknown", tone: "unknown" });
    expect(axes.conversation).toMatchObject({ word: "unknown", tone: "unknown" });
    expect(axes.readiness.every((axis) => axis.word === "unknown" && axis.tone === "unknown")).toBe(
      true,
    );
    expect(axes.usage.every((cell) => cell.text === "unknown")).toBe(true);
  });

  it("keeps usage kinds distinct and never gives an unknown line a number", () => {
    const axes = statusAxes({
      section: section(),
      conversationState: null,
      inspection: inspection({
        usage: {
          lines: [],
          totals: { reported: { tokens: 12400 }, estimated: {}, unknownLines: 2 },
        },
      }),
    });
    expect(axes.usage).toEqual([
      { kind: "reported", text: "12,400 tokens" },
      { kind: "estimated", text: "none recorded" },
      { kind: "unknown", text: "2 lines — no number exists" },
    ]);
  });

  it("never styles any tone green, and unknown carries its own amber class", () => {
    for (const classes of Object.values(toneClass)) {
      expect(classes).not.toMatch(/green|emerald|lime/);
    }
    expect(toneClass.unknown).toMatch(/amber/);
    for (const state of clarificationLifecycleStates) {
      const chip = runChipFor(state);
      expect(chip.word).toBe(state);
      if (state === "unknown") expect(chip.tone).toBe("unknown");
    }
  });
});

describe("the operational timeline", () => {
  const retried = section({
    attempts: [attempt("a1", "terminal"), attempt("a2", "active")],
    events: [
      op(1, "run.started", { issueId: "230", requestId: "start-1" }),
      op(2, "attempt.recorded", { attemptId: "a1" }),
      op(3, "conversation.prompt", { attemptId: "a1", requestId: "p1", text: "secret question" }),
      envelope(4, {
        type: "conversation",
        attemptId: "a1",
        session: { cursor: 1, envelope: "pi-managed/v1", event: { type: "message_update" } },
      }),
      op(5, "attempt.outcome", {
        attemptId: "a1",
        kind: "rejected",
        classification: "known-failure",
        nextAction: "manual-retry",
      }),
      op(6, "attempt.recorded", { attemptId: "a2", retry: true, requestId: "retry-1" }),
    ],
  });

  it("segments by attempt so a retry reads as a second segment", () => {
    const timeline = operationalTimeline(retried);
    expect(timeline.segments.map((segment) => segment.heading)).toEqual([
      "run",
      "attempt 1 — started by your explicit start",
      "attempt 2 — started after manual retry",
    ]);
    expect(timeline.segments[2].entries[0].text).toBe(
      "fresh attempt recorded after your manual retry",
    );
    expect(timeline.segments[1].entries.map((entry) => entry.text)).toContain(
      "outcome classified known-failure (rejected) — next: manual-retry",
    );
  });

  it("references the conversation by count, never duplicating its content", () => {
    const timeline = operationalTimeline(retried);
    expect(timeline.segments[1].conversationEvents).toBe(2);
    expect(
      JSON.stringify(timeline.segments.map((s) => s.entries.map((e) => e.text))),
    ).not.toContain("secret question");
  });

  it("keeps the raw event behind each plain-language entry", () => {
    const timeline = operationalTimeline(retried);
    const outcome = timeline.segments[1].entries.find((entry) => entry.cursor === 5);
    expect(outcome?.raw).toMatchObject({ kind: "attempt.outcome" });
  });

  it("names a gap explicitly and counts what is missing", () => {
    const timeline = operationalTimeline(
      section({ gap: { after: 0, firstRetainedCursor: 5 }, events: [op(5, "draft.saved")] }),
    );
    expect(timeline.gap).toEqual({ missing: 4, text: "— 4 earlier events not retained —" });
  });

  it("names a discarded ledger instead of rendering an empty, complete-looking history", () => {
    const timeline = operationalTimeline(
      section({ run: { ...section().run, state: "terminal", discardedAt: "2026-09-18T11:00Z" } }),
    );
    expect(timeline.discarded).toContain("discarded at 2026-09-18T11:00Z");
    expect(timeline.segments).toEqual([]);
  });

  it("renders an Unknown outcome's entry in the unknown tone", () => {
    const timeline = operationalTimeline(
      section({ events: [op(1, "attempt.process-death", { attemptId: "a1" })] }),
    );
    expect(timeline.segments[0].entries[0].tone).toBe("unknown");
  });
});

describe("ownership and the controls-moved notice", () => {
  const events = [
    op(1, "conversation.prompt", { attemptId: "a1", requestId: "mine-1" }),
    op(2, "conversation.prompt", { attemptId: "a1", requestId: "theirs-1" }),
  ];

  it("flags controls moved when another viewer acted after this tab", () => {
    const ownership = ownershipFor({
      inspection: inspection(),
      events,
      ownRequestIds: new Set(["mine-1"]),
      now: NOW,
    });
    expect(ownership).toEqual({
      state: "another-viewer",
      text: "held by another viewer",
      controlsMoved: true,
    });
  });

  it("holds controls for this tab when its act is the newest", () => {
    expect(
      ownershipFor({
        inspection: inspection(),
        events,
        ownRequestIds: new Set(["theirs-1"]),
        now: NOW,
      }).state,
    ).toBe("this-tab");
  });

  it("is unheld when the lease is absent or expired", () => {
    for (const lease of [
      null,
      { ...inspection().lease!, expired: true },
      { ...inspection().lease!, expiresAt: "2026-09-18T10:00:05.000Z" },
    ]) {
      expect(
        ownershipFor({
          inspection: inspection({ lease }),
          events,
          ownRequestIds: new Set(["mine-1"]),
          now: NOW,
        }),
      ).toMatchObject({ state: "unheld", controlsMoved: false });
    }
  });
});

describe("the action matrix", () => {
  const parked = section({
    run: { ...section().run, state: "awaiting-human" },
    attempts: [attempt("a1", "terminal")],
  });

  it("classes every act and makes discard the single destructive, typed one", () => {
    const matrix = actionMatrix({ section: parked, following: true, turnLive: false });
    const classOf = Object.fromEntries(matrix.map((action) => [action.id, action.class]));
    expect(classOf).toEqual({
      detach: "direct",
      reconnect: "direct",
      reconcile: "direct",
      "stop-turn": "two-step",
      "cancel-attempt": "two-step",
      "retain-evidence": "two-step",
      "discard-evidence": "typed",
      retry: "fresh-approval",
      publish: "fresh-approval",
    });
    const destructive = matrix.filter((action) => action.destructive);
    expect(destructive.map((action) => action.id)).toEqual(["discard-evidence"]);
    expect(destructive[0].class).toBe("typed");
  });

  it("offers detach while following and reconnect after detaching", () => {
    const following = actionMatrix({ section: parked, following: true, turnLive: false });
    const detached = actionMatrix({ section: parked, following: false, turnLive: false });
    const available = (matrix: typeof following, id: string) =>
      matrix.find((action) => action.id === id)?.available;
    expect(available(following, "detach")).toBe(true);
    expect(available(following, "reconnect")).toBe(false);
    expect(available(detached, "detach")).toBe(false);
    expect(available(detached, "reconnect")).toBe(true);
  });

  it("withholds retry, retain and discard from a live run", () => {
    const matrix = actionMatrix({ section: section(), following: true, turnLive: true });
    const available = (id: string) => matrix.find((action) => action.id === id)?.available;
    expect(available("retry")).toBe(false);
    expect(available("retain-evidence")).toBe(false);
    expect(available("discard-evidence")).toBe(false);
    expect(available("cancel-attempt")).toBe(true);
    expect(available("stop-turn")).toBe(true);
  });
});

describe("the return card", () => {
  const ownership = { state: "unheld" as const, text: "unheld", controlsMoved: false };

  it("renders on awaiting-human with the checkpoint fields and one primary action", () => {
    const card = returnCardFor({
      section: section({
        run: { ...section().run, state: "awaiting-human" },
        attempts: [attempt("a1", "terminal")],
        events: [op(1, "attempt.start-denied", { attemptId: "a1", code: "runtime_unconfigured" })],
      }),
      inspection: inspection(),
      ownership,
    });
    expect(card?.reason).toBe("awaiting-human");
    expect(Object.keys(card!.fields).sort()).toEqual(
      [
        "changedFiles",
        "checks",
        "lastTrustedEvent",
        "missingDecision",
        "ownership",
        "state",
      ].sort(),
    );
    expect(card!.fields.lastTrustedEvent).toContain("#1");
    expect(card!.fields.missingDecision).toContain("retry as a fresh attempt");
    expect(card!.primary).toEqual({ id: "retry", label: "Start fresh attempt" });
  });

  it("leads with the escalation's decision when the run halted", () => {
    const card = returnCardFor({
      section: section({
        run: { ...section().run, state: "awaiting-human" },
        attempts: [attempt("a1", "terminal"), attempt("a2", "terminal")],
      }),
      inspection: inspection({
        escalations: [
          {
            attemptId: "a2",
            signature: "sig",
            repeats: 2,
            classification: "known-failure",
            kind: "rejected",
            remainingAuthority: ["manual-retry"],
            decision: "decide whether to start a fresh manual attempt or abandon this run",
            at: "t",
          },
        ],
      }),
      ownership,
    });
    expect(card!.fields.missingDecision).toContain("repeated 2×");
  });

  it("renders on reconciling with read-only reconcile as the primary action", () => {
    const card = returnCardFor({
      section: section({ run: { ...section().run, state: "reconciling" } }),
      inspection: null,
      ownership,
    });
    expect(card?.primary.id).toBe("reconcile");
    expect(card!.fields.checks).toContain("tracker-eligibility unknown");
  });

  it("renders on reconnect-after-gap with Follow live for an active run", () => {
    const card = returnCardFor({
      section: section({ gap: { after: 0, firstRetainedCursor: 9 } }),
      inspection: inspection(),
      ownership,
    });
    expect(card?.reason).toBe("gap");
    expect(card?.primary).toEqual({ id: "follow-live", label: "Follow live" });
  });

  it("stays away from an active run with no gap", () => {
    expect(returnCardFor({ section: section(), inspection: inspection(), ownership })).toBeNull();
  });
});

// The phase fence: workflow phases are GitHub labels. Run state reaches the
// In flight view as a chip only — bucket membership (which derives from the
// phase) is computed from work items alone, and no projection here produces
// or consumes a phase.
describe("run events never move workflow phases", () => {
  const item = (number: number, phase: WorkItemRecord["phase"]): WorkItemRecord => ({
    id: `GH-${number}`,
    title: `Issue ${number}`,
    url: `https://github.com/example/project/issues/${number}`,
    state: "open",
    assignees: ["dev"],
    phase,
    triageState: "unlabeled",
    deferred: false,
    category: null,
    kind: null,
    summary: "",
  });

  it("keeps In flight buckets a function of work items alone", () => {
    const items = [item(230, "implementing"), item(231, "reviewing")];
    const before = JSON.stringify(inFlightBuckets(items));
    // Every run state and every ledger event projected — the work items and
    // their buckets are untouched.
    for (const state of clarificationLifecycleStates) {
      const run = section({
        run: { ...section().run, state },
        events: [op(1, "attempt.outcome", { attemptId: "a1", classification: "unknown" })],
      });
      statusAxes({ section: run, conversationState: null, inspection: null });
      operationalTimeline(run);
      returnCardFor({
        section: run,
        inspection: null,
        ownership: ownershipFor({
          inspection: null,
          events: [],
          ownRequestIds: new Set(),
          now: NOW,
        }),
      });
      runChipFor(state);
    }
    expect(JSON.stringify(inFlightBuckets(items))).toBe(before);
    expect(items.map((record) => record.phase)).toEqual(["implementing", "reviewing"]);
  });

  it("produces no phase anywhere in its output", () => {
    const run = section({ run: { ...section().run, state: "awaiting-human" } });
    const output = JSON.stringify([
      statusAxes({ section: run, conversationState: null, inspection: inspection() }),
      operationalTimeline(run),
      actionMatrix({ section: run, following: true, turnLive: false }),
      returnCardFor({
        section: run,
        inspection: inspection(),
        ownership: { state: "unheld", text: "unheld", controlsMoved: false },
      }),
    ]);
    expect(output).not.toMatch(/"phase"|workflow:/);
  });
});
