import { describe, expect, it } from "vite-plus/test";

import type { WorkItemRecord } from "../types";
import { deriveDisplayState } from "./display-state";

const workItem = (overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id: "GH-1",
  title: "Work item",
  url: "https://github.com/example/project/issues/1",
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

describe("display-state derivation", () => {
  it("derives a clean item with no caveats", () => {
    const state = deriveDisplayState(
      workItem({ phase: "implementing", triageState: "ready-for-agent", assignees: ["vvaz"] }),
      false,
    );

    expect(state).toEqual({
      state: "open",
      phase: "implementing",
      triageState: "ready-for-agent",
      deferred: false,
      claimed: true,
      blocked: false,
      caveats: [],
    });
  });

  it("carries deferred, closed, and computed-blocked onto the display state", () => {
    const state = deriveDisplayState(
      workItem({ state: "closed", phase: "shipped", deferred: true }),
      true,
    );

    expect(state.state).toBe("closed");
    expect(state.phase).toBe("shipped");
    expect(state.deferred).toBe(true);
    expect(state.blocked).toBe(true);
    expect(state.claimed).toBe(false);
    expect(state.caveats).toEqual([]);
  });

  it("ignores the phase of a decision ticket for flow math, with a caveat", () => {
    for (const kind of ["research", "prototype", "grilling", "task"] as const) {
      const state = deriveDisplayState(workItem({ kind, phase: "implementing" }), false);

      expect(state.phase).toBe(null);
      expect(state.caveats.map((caveat) => caveat.kind)).toEqual(["decision-ticket-phase"]);
      expect(state.caveats[0].message).toMatch(/implementing/);
      expect(state.caveats[0].message).toMatch(/decision ticket/);
    }
  });

  it("keeps the phase of a map issue — the map carries phase like any issue", () => {
    const state = deriveDisplayState(workItem({ kind: "map", phase: "specced" }), false);

    expect(state.phase).toBe("specced");
    expect(state.caveats).toEqual([]);
  });

  it("caveats implementing while waiting on the reporter", () => {
    const state = deriveDisplayState(
      workItem({ phase: "implementing", triageState: "needs-info" }),
      false,
    );

    expect(state.caveats.map((caveat) => caveat.kind)).toEqual(["implementing-needs-info"]);
    expect(state.caveats[0].message).toMatch(/implementing/);
    expect(state.caveats[0].message).toMatch(/needs-info/);
  });

  it("caveats shipped work still open", () => {
    const state = deriveDisplayState(workItem({ phase: "shipped" }), false);

    expect(state.caveats.map((caveat) => caveat.kind)).toEqual(["shipped-open"]);
    expect(state.caveats[0].message).toMatch(/shipped/);
    expect(state.caveats[0].message).toMatch(/open/);
  });

  it("caveats grilling work refused as wontfix", () => {
    const state = deriveDisplayState(
      workItem({ phase: "grilling", triageState: "wontfix" }),
      false,
    );

    expect(state.caveats.map((caveat) => caveat.kind)).toEqual(["grilling-wontfix"]);
  });

  it("caveats an in-flow item closed without shipped, but not a pre-flow closure", () => {
    const retired = deriveDisplayState(
      workItem({ state: "closed", phase: "ticketed", triageState: "ready-for-agent" }),
      false,
    );
    expect(retired.caveats.map((caveat) => caveat.kind)).toEqual(["closed-without-shipped"]);

    const refused = deriveDisplayState(workItem({ state: "closed" }), false);
    expect(refused.caveats).toEqual([]);

    const complete = deriveDisplayState(workItem({ state: "closed", phase: "shipped" }), false);
    expect(complete.caveats).toEqual([]);
  });

  it("exposes every caveat an item earns, never hiding one behind another", () => {
    const state = deriveDisplayState(
      workItem({ kind: "task", phase: "implementing", triageState: "needs-info" }),
      false,
    );

    expect(state.caveats.map((caveat) => caveat.kind)).toEqual([
      "decision-ticket-phase",
      "implementing-needs-info",
    ]);
  });

  it("derives a new state without relabelling or writing back to the record", () => {
    const record = workItem({ kind: "task", phase: "implementing", triageState: "needs-info" });
    const snapshot = structuredClone(record);

    deriveDisplayState(record, true);

    expect(record).toEqual(snapshot);
  });
});
