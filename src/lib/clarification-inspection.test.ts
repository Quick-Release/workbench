import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, expect, it } from "vite-plus/test";

import type { ClarificationRunResult } from "../schema";
import type { StatusPanel } from "./clarification-inspection";
import {
  discardable,
  ownershipFor,
  runChipFor,
  statusPanels,
  timelineSegments,
  usageTotalsLine,
  returnCard,
} from "./clarification-inspection";

// A narrowing read of one panel: the tests fail loudly when an axis is
// missing instead of tripping over undefined.
const panelOf = <K extends StatusPanel["axis"]>(panels: StatusPanel[], axis: K) => {
  const panel = panels.find((candidate) => candidate.axis === axis);
  if (panel === undefined || panel.axis !== axis) throw new Error(`no ${axis} panel`);
  return panel as Extract<StatusPanel, { axis: K }>;
};

// The inspection display's projection tests (spec #221, ticket #237,
// Factory 11): pure functions over the settled record contracts — no fetch,
// no React. The rules under test are the display layer's acceptance
// criteria: no merged status word, every axis in its owner's vocabulary,
// one timeline segmented by attempt with the conversation referenced and
// gaps explicit, the return card's checkpoint fields with exactly one
// primary action, and unknown rendered as the word — never averaged away.

const attempt = (overrides: Record<string, unknown> = {}) => ({
  attemptId: "attempt_1",
  runId: "run_1",
  hostRepo: "example/project",
  requestId: "req-1",
  dispatchIntent: { kind: "clarification-start", provider: "p", dataDestination: "d" },
  state: "active",
  origin: "manual",
  createdAt: "2026-09-18T10:00:03.000Z",
  updatedAt: "2026-09-18T10:00:03.000Z",
  ...overrides,
});

const section = (overrides: Record<string, unknown> = {}): ClarificationRunResult =>
  ({
    run: {
      runId: "run_1",
      hostRepo: "example/project",
      issueId: "230",
      requestId: "req-1",
      state: "active",
      createdAt: "2026-09-18T10:00:01.000Z",
      updatedAt: "2026-09-18T10:00:09.000Z",
      discardedAt: null,
    },
    attempts: [attempt()],
    latestCursor: 2,
    events: [],
    lease: null,
    usage: { runId: "run_1", lines: [], totals: { reported: {}, estimated: {}, unknownLines: 0 } },
    escalations: [],
    ...overrides,
  }) as unknown as ClarificationRunResult;

describe("statusPanels — panel-per-axis, never a merged status word", () => {
  it("renders five axes, each carrying its owner's word", () => {
    const panels = statusPanels(section(), {});
    deepStrictEqual(
      panels.map((panel) => panel.axis),
      ["run", "attempts", "conversation", "readiness", "usage"],
    );
    strictEqual(panels[0].axis, "run");
    strictEqual(panelOf(panels, "run").state, "active");
  });

  it("renders the attempts axis with each attempt's lifecycle word and origin", () => {
    const panels = statusPanels(
      section({
        attempts: [
          attempt({
            attemptId: "attempt_1",
            state: "terminal",
            origin: "manual",
            updatedAt: "2026-09-18T10:05:00.000Z",
          }),
          attempt({
            attemptId: "attempt_2",
            state: "awaiting-human",
            origin: "manual",
            createdAt: "2026-09-18T10:06:00.000Z",
            updatedAt: "2026-09-18T10:07:00.000Z",
          }),
        ],
      }),
      {},
    );
    const attempts = panelOf(panels, "attempts");
    deepStrictEqual(
      attempts.attempts.map((row) => [row.attemptId, row.state, row.origin]),
      [
        ["attempt_1", "terminal", "manual"],
        ["attempt_2", "awaiting-human", "manual"],
      ],
    );
  });

  it("renders the conversation axis in the session's own word, unknown when the session is not live", () => {
    const live = statusPanels(section(), {
      conversation: { available: true, sessionState: "waiting-for-input" },
    });
    const livePanel = panelOf(live, "conversation");
    strictEqual(livePanel.state, "waiting-for-input");
    strictEqual(livePanel.live, true);

    const detached = statusPanels(section(), { conversation: null });
    const detachedPanel = panelOf(detached, "conversation");
    // Unknown renders as the word — never a guess at the session's state.
    strictEqual(detachedPanel.state, "unknown");
    strictEqual(detachedPanel.live, false);

    const unnamed = statusPanels(section(), { conversation: { available: true } });
    const unnamedPanel = panelOf(unnamed, "conversation");
    strictEqual(unnamedPanel.state, "unknown");
  });

  it("renders the readiness axis in the draft completeness' word, unknown when no draft read exists", () => {
    const ready = statusPanels(section(), { readiness: { verdict: "ready", gaps: [] } });
    const readyPanel = panelOf(ready, "readiness");
    strictEqual(readyPanel.verdict, "ready");
    strictEqual(readyPanel.gapCount, 0);

    const gapped = statusPanels(section(), {
      readiness: { verdict: "needs-information", gaps: ["a", "b"] },
    });
    const gappedPanel = panelOf(gapped, "readiness");
    strictEqual(gappedPanel.verdict, "needs-information");
    strictEqual(gappedPanel.gapCount, 2);

    const unread = statusPanels(section(), {});
    const unreadPanel = panelOf(unread, "readiness");
    strictEqual(unreadPanel.verdict, "unknown");
    strictEqual(unreadPanel.gapCount, 0);
  });

  it("renders the usage axis with its lines and honest totals, never converting kinds", () => {
    const panels = statusPanels(
      section({
        usage: {
          runId: "run_1",
          lines: [
            {
              lineId: "usage_1",
              kind: "reported",
              unit: "provider",
              value: null,
              detail: { totalTokens: 12400 },
              createdAt: "t",
            },
            {
              lineId: "usage_2",
              kind: "unknown",
              unit: "subscription",
              value: null,
              createdAt: "t",
            },
          ],
          totals: { reported: {}, estimated: {}, unknownLines: 1 },
        },
      }),
      {},
    );
    const usage = panelOf(panels, "usage");
    strictEqual(usage.lines.length, 2);
    deepStrictEqual(usage.totals, { reported: {}, estimated: {}, unknownLines: 1 });
  });

  it("never emits a workflow-phase word: the run axis speaks only the lifecycle vocabulary", () => {
    const panels = statusPanels(section({ run: { state: "awaiting-human" } }), {});
    for (const panel of panels) {
      const words = JSON.stringify(panel);
      for (const phase of [
        "grilling",
        "prototyping",
        "specced",
        "ticketed",
        "implementing",
        "reviewing",
        "shipped",
      ])
        expect(words).not.toContain(phase);
    }
  });
});

describe("ownershipFor — the lease's three display states", () => {
  it("reads unheld when there is no lease or it has expired", () => {
    deepStrictEqual(ownershipFor(null), { state: "unheld" });
    deepStrictEqual(
      ownershipFor({
        owner: "workbench-clarification-coordinator",
        generation: 1,
        acquiredAt: "a",
        expiresAt: "e",
        expired: true,
      }),
      { state: "unheld" },
    );
  });

  it("reads held when the coordinator owns the live lease", () => {
    deepStrictEqual(
      ownershipFor({
        owner: "workbench-clarification-coordinator",
        generation: 2,
        acquiredAt: "2026-09-18T10:00:05.000Z",
        expiresAt: "2026-09-18T10:00:35.000Z",
        expired: false,
      }),
      {
        state: "held",
        owner: "workbench-clarification-coordinator",
        expiresAt: "2026-09-18T10:00:35.000Z",
      },
    );
  });

  it("reads elsewhere when another writer holds the live lease — the controls-moved fact", () => {
    deepStrictEqual(
      ownershipFor({
        owner: "some-other-writer",
        generation: 3,
        acquiredAt: "a",
        expiresAt: "2026-09-18T11:00:00.000Z",
        expired: false,
      }),
      { state: "elsewhere", owner: "some-other-writer", expiresAt: "2026-09-18T11:00:00.000Z" },
    );
  });
});

describe("usageTotalsLine — the budget's honest summary", () => {
  it("renders every kind in its own word, an empty sum as a dash, unknown as a count", () => {
    strictEqual(
      usageTotalsLine({ reported: { provider: 12400 }, estimated: {}, unknownLines: 1 }),
      "reported 12.4k provider · estimated — · unknown 1 line",
    );
    strictEqual(
      usageTotalsLine({ reported: {}, estimated: {}, unknownLines: 0 }),
      "reported — · estimated — · unknown 0 lines",
    );
  });
});

describe("timelineSegments — one timeline per run, segmented by attempt", () => {
  const envelope = (cursor: number, event: unknown) => ({
    cursor,
    envelope: "clarification-events/v1",
    event,
  });

  it("segments by attempt, numbers retry segments, and routes events to their owner", () => {
    const timeline = timelineSegments(
      section({
        attempts: [
          attempt({ attemptId: "attempt_1", state: "terminal", origin: "manual" }),
          attempt({
            attemptId: "attempt_2",
            state: "awaiting-human",
            origin: "coordinator-retry",
          }),
        ],
        latestCursor: 4,
        events: [
          envelope(1, {
            type: "operational",
            kind: "run.started",
            data: { issueId: "230", requestId: "req-1" },
            at: "2026-09-18T10:00:01.000Z",
          }),
          envelope(2, {
            type: "operational",
            kind: "attempt.recorded",
            data: { attemptId: "attempt_1", issueNumber: 230 },
            at: "t",
          }),
          envelope(3, {
            type: "lifecycle",
            scope: "attempt",
            id: "attempt_1",
            state: "terminal",
            at: "t",
          }),
          envelope(4, {
            type: "operational",
            kind: "attempt.coordinator-retried",
            data: { fromAttemptId: "attempt_1", attemptId: "attempt_2" },
            at: "t",
          }),
        ],
      }),
    );

    deepStrictEqual(
      timeline.segments.map((segment) => segment.key),
      ["run", "attempt_1", "attempt_2"],
    );
    const second = timeline.segments[2];
    // A retry reads as its own segment, named as the coordinator's
    // evidence-gated retry — not one blur.
    expect(second.heading).toContain("attempt 2");
    expect(second.heading).toContain("retry");
    // The retry event lives in the second attempt's segment.
    expect(second.entries.map((entry) => entry.sentence).join(" ")).toContain("attempt 2");
  });

  it("renders plain-language sentences and keeps the raw event behind the detail", () => {
    const timeline = timelineSegments(
      section({
        events: [
          envelope(1, {
            type: "operational",
            kind: "run.started",
            data: { issueId: "230", requestId: "req-1" },
            at: "2026-09-18T10:00:01.000Z",
          }),
          envelope(2, {
            type: "operational",
            kind: "attempt.outcome",
            data: {
              attemptId: "attempt_1",
              kind: "provider-failure",
              classification: "known-failure",
              nextAction: "await-human",
              reason: "quota",
            },
            at: "t",
          }),
        ],
      }),
    );
    const run = timeline.segments[0];
    expect(run.entries[0].sentence).toContain("run started");
    deepStrictEqual(run.entries[0].detail, '{"issueId":"230","requestId":"req-1"}');

    const attemptSegment = timeline.segments[1];
    const outcome = attemptSegment.entries[0];
    expect(outcome.sentence).toContain("attempt 1");
    expect(outcome.sentence).toContain("quota");
    expect(outcome.sentence).toContain("await-human");
    ok(outcome.detail !== undefined);
  });

  it("references the conversation once per attempt segment, never duplicating it", () => {
    const timeline = timelineSegments(
      section({
        events: [
          envelope(1, {
            type: "conversation",
            attemptId: "attempt_1",
            session: {
              cursor: 1,
              envelope: "pi-managed/v1",
              event: { type: "message_update", text: "a streamed answer" },
            },
          }),
          envelope(2, {
            type: "conversation",
            attemptId: "attempt_1",
            session: {
              cursor: 2,
              envelope: "pi-managed/v1",
              event: { type: "message_update", text: "another streamed answer" },
            },
          }),
        ],
      }),
    );
    const serialized = JSON.stringify(timeline);
    // The streamed text never enters the timeline.
    expect(serialized).not.toContain("a streamed answer");
    const attemptSegment = timeline.segments[1];
    // Many frames, one reference.
    strictEqual(attemptSegment.entries.filter((entry) => entry.reference).length, 1);

    const quiet = timelineSegments(section());
    strictEqual(quiet.segments[1].entries.length, 0);
  });

  it("makes an expired cursor's gap explicit as the divider, counting what is gone", () => {
    const timeline = timelineSegments(
      section({
        gap: { after: 0, firstRetainedCursor: 4 },
      }),
    );
    ok(timeline.gapDivider !== undefined);
    strictEqual(timeline.gapDivider.hiddenCount, 3);
    strictEqual(timeline.gapDivider.firstRetainedCursor, 4);

    const healthy = timelineSegments(section());
    strictEqual(healthy.gapDivider, undefined);
  });

  it("never duplicates the conversation commands as timeline entries", () => {
    const timeline = timelineSegments(
      section({
        events: [
          {
            cursor: 1,
            envelope: "clarification-events/v1",
            event: {
              type: "operational",
              kind: "conversation.prompt",
              data: { attemptId: "attempt_1", requestId: "r1", text: "the question itself" },
              at: "t",
            },
          },
        ],
      }),
    );
    for (const segment of timeline.segments) strictEqual(segment.entries.length, 0);
    strictEqual(JSON.stringify(timeline).includes("the question itself"), false);
  });

  it("renders unknown operational kinds as themselves — evidence, never a silent drop", () => {
    const timeline = timelineSegments(
      section({
        events: [
          envelope(1, {
            type: "operational",
            kind: "capability.something-new",
            data: { capability: "x" },
            at: "t",
          }),
        ],
      }),
    );
    const entry = timeline.segments[0].entries[0];
    expect(entry.sentence).toContain("capability.something-new");
    ok(entry.detail !== undefined);
  });
});

describe("returnCard — checkpoint fields and exactly one primary action", () => {
  it("stays hidden for a healthy active run with no gap", () => {
    strictEqual(returnCard(section()), null);
  });

  it("renders on reconnect-after-gap with Follow live as the one primary action", () => {
    const card = returnCard(section({ gap: { after: 0, firstRetainedCursor: 3 } }));
    ok(card !== null);
    strictEqual(card.reason, "gap");
    strictEqual(card.primary.action, "follow-live");
    expect(card.primary.label).toContain("Follow live");
    strictEqual(card.missingDecision, null);
  });

  it("renders for an awaiting-human run with the escalation's decision as the missing decision", () => {
    const card = returnCard(
      section({
        run: { state: "awaiting-human" },
        attempts: [attempt({ attemptId: "attempt_1", state: "awaiting-human" })],
        escalations: [
          {
            runId: "run_1",
            attemptId: "attempt_1",
            signature: "sig",
            repeats: 2,
            classification: "known-failure",
            kind: "provider-failure",
            reason: "quota",
            remainingAuthority: ["manual-retry"],
            decision: "decide whether to start a fresh manual attempt or abandon this run",
            at: "t",
          },
        ],
      }),
    );
    ok(card !== null);
    strictEqual(card.reason, "awaiting-human");
    strictEqual(
      card.missingDecision,
      "decide whether to start a fresh manual attempt or abandon this run",
    );
    // Exactly one primary action, and it is the review — never the
    // destructive discard.
    strictEqual(card.primary.action, "review-timeline");
  });

  it("renders for a reconciling run", () => {
    const card = returnCard(section({ run: { state: "reconciling" } }));
    ok(card !== null);
    strictEqual(card.reason, "reconciling");
    strictEqual(card.primary.action, "review-timeline");
  });

  it("carries the checkpoint fields: states, ownership, last trusted event", () => {
    const card = returnCard(
      section({
        run: { state: "awaiting-human" },
        attempts: [attempt({ attemptId: "attempt_1", state: "awaiting-human" })],
        lease: {
          owner: "workbench-clarification-coordinator",
          generation: 1,
          acquiredAt: "a",
          expiresAt: "e",
          expired: false,
        },
        latestCursor: 5,
        events: [
          {
            cursor: 5,
            envelope: "clarification-events/v1",
            event: {
              type: "operational",
              kind: "run.halted",
              data: { signature: "sig", repeats: 2 },
              at: "2026-09-18T10:00:09.000Z",
            },
          },
        ],
      }),
    );
    ok(card !== null);
    strictEqual(card.runState, "awaiting-human");
    strictEqual(card.attemptState, "awaiting-human");
    strictEqual(card.ownership.state, "held");
    ok(card.lastTrustedEvent !== null);
    strictEqual(card.lastTrustedEvent.cursor, 5);
    strictEqual(card.lastTrustedEvent.at, "2026-09-18T10:00:09.000Z");
    // The summary speaks the timeline's plain language, not the raw kind.
    expect(card.lastTrustedEvent.summary).toContain("run halted awaiting a human");
  });
});

describe("runChipFor and discardable — the In flight chip and the destructive gate", () => {
  const run = (overrides: Record<string, unknown> = {}) => ({
    runId: "run_1",
    issueId: "230",
    state: "active",
    createdAt: "2026-09-18T10:00:01.000Z",
    updatedAt: "2026-09-18T10:00:01.000Z",
    ...overrides,
  });

  it("chips the newest non-terminal run for the issue, nothing when there is none", () => {
    strictEqual(
      runChipFor(
        [
          run({ runId: "run_1", createdAt: "2026-09-18T10:00:01.000Z" }),
          run({ runId: "run_2", state: "awaiting-human", createdAt: "2026-09-18T11:00:01.000Z" }),
        ],
        "230",
      ),
      "awaiting-human",
    );
    // A terminal latest run is finished — In flight shows live work only.
    strictEqual(runChipFor([run({ state: "terminal" })], "230"), null);
    strictEqual(runChipFor([run()], "999"), null);
  });

  it("gates the discard to the recovery states the store calls discardable", () => {
    const discardableStates = ["unknown", "awaiting-human", "quarantined"] as const;
    for (const state of discardableStates) strictEqual(discardable({ state }), true, state);
    const otherStates = ["active", "reconciling", "terminal"] as const;
    for (const state of otherStates) strictEqual(discardable({ state }), false, state);
  });
});

function ok(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? "expected truthy");
}
