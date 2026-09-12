import { describe, expect, it } from "vite-plus/test";

import type { WorkItemRecord } from "../types";
import { phaseClockLine, phaseSinceFromEvents } from "./phase-clock";

const item = (overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id: "GH-8",
  title: "Issue 8",
  url: "https://github.com/Quick-Release/workbench/issues/8",
  state: "open",
  assignees: [],
  phase: null,
  triageState: "unlabeled",
  deferred: false,
  category: null,
  kind: null,
  summary: "",
  ...overrides,
});

const labeled = (name: string, createdAt: string) => ({
  event: "labeled",
  label: { name },
  created_at: createdAt,
});

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

describe("phaseSinceFromEvents", () => {
  it("clocks the latest labeled event for the phase's label, so re-entry resets", () => {
    // GitHub answers newest-first; the earlier stay must lose to the re-entry.
    const events = [
      labeled("workflow:implementing", "2026-09-08T09:00:00.000Z"),
      labeled("needs-info", "2026-09-07T09:00:00.000Z"),
      labeled("workflow:ticketed", "2026-09-05T09:00:00.000Z"),
      labeled("workflow:implementing", "2026-09-03T09:00:00.000Z"),
    ];
    expect(phaseSinceFromEvents(events, "workflow:implementing")).toBe("2026-09-08T09:00:00.000Z");
  });

  it("derives the same clock whatever order the events arrive in", () => {
    const events = [
      labeled("workflow:ticketed", "2026-09-05T09:00:00.000Z"),
      labeled("workflow:implementing", "2026-09-08T09:00:00.000Z"),
      labeled("workflow:implementing", "2026-09-03T09:00:00.000Z"),
    ];
    expect(phaseSinceFromEvents(events, "workflow:implementing")).toBe("2026-09-08T09:00:00.000Z");
  });

  it("never clocks another label, an unlabeled event, or a stampless entry", () => {
    const events = [
      { event: "closed", created_at: "2026-09-10T09:00:00.000Z" },
      labeled("workflow:reviewing", "2026-09-09T09:00:00.000Z"),
      { event: "labeled", created_at: "2026-09-08T09:00:00.000Z" },
      { event: "labeled", label: { name: "workflow:implementing" } },
      { event: "labeled", label: { name: "workflow:implementing" }, created_at: "not a date" },
    ];
    expect(phaseSinceFromEvents(events, "workflow:implementing")).toBeNull();
    expect(phaseSinceFromEvents([], "workflow:implementing")).toBeNull();
  });
});

describe("phaseClockLine", () => {
  it("reads a phase-labelled card's time in phase", () => {
    const record = item({
      phase: "implementing",
      phaseSince: "2026-09-08T12:00:00.000Z",
    });
    expect(phaseClockLine(record, NOW)).toEqual({
      text: "4d in implementing",
      source: "phase",
    });
  });

  it("speaks the duration ladder the freshness chip speaks", () => {
    const at = (msBeforeNow: number) =>
      item({ phase: "reviewing", phaseSince: new Date(NOW - msBeforeNow).toISOString() });
    expect(phaseClockLine(at(30_000), NOW)?.text).toBe("just now in reviewing");
    expect(phaseClockLine(at(5 * 60_000), NOW)?.text).toBe("5m in reviewing");
    expect(phaseClockLine(at(3 * 3_600_000), NOW)?.text).toBe("3h in reviewing");
    expect(phaseClockLine(at(4 * 86_400_000), NOW)?.text).toBe("4d in reviewing");
  });

  it("shows no clock for decision tickets and pre-flow items", () => {
    const decision = item({
      kind: "task",
      phase: "ticketed",
      phaseSince: "2026-09-08T12:00:00.000Z",
      updatedAt: "2026-09-11T12:00:00.000Z",
    });
    expect(phaseClockLine(decision, NOW)).toBeNull();
    const preFlow = item({
      phase: null,
      phaseSince: "2026-09-08T12:00:00.000Z",
      updatedAt: "2026-09-11T12:00:00.000Z",
    });
    expect(phaseClockLine(preFlow, NOW)).toBeNull();
  });

  it("falls back to last-touched where no clock exists, never posing as time in phase", () => {
    const record = item({ phase: "implementing", updatedAt: "2026-09-12T09:00:00.000Z" });
    expect(phaseClockLine(record, NOW)).toEqual({
      text: "last touched 3h ago",
      source: "last-touched",
    });
    // An unreadable clock falls back too; nothing at all renders without
    // either timestamp.
    expect(
      phaseClockLine(
        item({
          phase: "implementing",
          phaseSince: "not a date",
          updatedAt: "2026-09-12T09:00:00.000Z",
        }),
        NOW,
      )?.source,
    ).toBe("last-touched");
    expect(phaseClockLine(item({ phase: "implementing" }), NOW)).toBeNull();
  });

  it("clocks a map like any phase-labelled work item", () => {
    const map = item({ kind: "map", phase: "specced", phaseSince: "2026-09-11T12:00:00.000Z" });
    expect(phaseClockLine(map, NOW)).toEqual({ text: "1d in specced", source: "phase" });
  });
});
