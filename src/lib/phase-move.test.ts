import { describe, expect, it } from "vite-plus/test";

import type { WorkItemRecord } from "../types";
import { phaseMoveCommand, phaseMoveTargetsFor } from "./phase-move";

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

describe("the phase move's target columns", () => {
  it("offers every column but the one the item sits in, in flow order", () => {
    expect(phaseMoveTargetsFor("implementing")).toEqual([
      "pre-flow",
      "grilling",
      "prototyping",
      "specced",
      "ticketed",
      "reviewing",
      "shipped",
    ]);
    expect(phaseMoveTargetsFor("pre-flow")).toEqual([
      "grilling",
      "prototyping",
      "specced",
      "ticketed",
      "implementing",
      "reviewing",
      "shipped",
    ]);
  });
});

describe("the static move command", () => {
  it("adds the target's phase label and strips every worn one but the target", () => {
    const record = item({
      phase: "reviewing",
      labels: ["workflow:implementing", "workflow:reviewing", "needs-info"],
    });
    expect(phaseMoveCommand(record, "ticketed")).toBe(
      "gh issue edit 8 --add-label workflow:ticketed --remove-label workflow:implementing --remove-label workflow:reviewing",
    );
  });

  it("strips every phase label and adds none on a move to pre-flow", () => {
    const record = item({
      phase: "implementing",
      labels: ["workflow:implementing", "needs-info"],
    });
    expect(phaseMoveCommand(record, "pre-flow")).toBe(
      "gh issue edit 8 --remove-label workflow:implementing",
    );
  });

  it("falls back to the resolved phase's label when raw labels do not ride", () => {
    expect(phaseMoveCommand(item({ phase: "implementing" }), "reviewing")).toBe(
      "gh issue edit 8 --add-label workflow:reviewing --remove-label workflow:implementing",
    );
  });

  it("passes no removal for pre-flow work wearing no phase label", () => {
    expect(phaseMoveCommand(item(), "grilling")).toBe(
      "gh issue edit 8 --add-label workflow:grilling",
    );
  });
});
