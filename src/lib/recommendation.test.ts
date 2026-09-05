import { describe, expect, it } from "vite-plus/test";

import type { BlockerEdgeRecord, TrackerMapRecord, WorkItemRecord } from "../types";
import type { WorkflowStatePayload } from "../types";
import { recommendNextAction, frontierStrip } from "./recommendation";

export const item = (number: number, overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id: `GH-${number}`,
  title: `Issue ${number}`,
  url: `https://github.com/Quick-Release/workbench/issues/${number}`,
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

export const edge = (blocked: number, blocker: number): BlockerEdgeRecord => ({
  blockedId: `GH-${blocked}`,
  blockerId: `GH-${blocker}`,
  source: "github-native",
  sourceRef: `https://github.com/Quick-Release/workbench/issues/${blocked}`,
});

export const map = (number: number, ticketIds: number[]): TrackerMapRecord => ({
  mapId: `GH-${number}`,
  title: `Map ${number}`,
  url: `https://github.com/Quick-Release/workbench/issues/${number}`,
  ticketIds: ticketIds.map((id) => `GH-${id}`),
});

export const state = (
  workItems: readonly WorkItemRecord[],
  maps: readonly TrackerMapRecord[] = [],
  blockerEdges: readonly BlockerEdgeRecord[] = [],
): WorkflowStatePayload => ({
  workItems,
  maps,
  blockerEdges,
  decisions: [],
  artifacts: [],
  meta: { snapshot: "2026-09-05T12:00:00+01:00", repo: "Quick-Release/workbench" },
});

describe("the recommendation engine", () => {
  it("recommends /implement on the head of the implementation frontier", () => {
    const recommendation = recommendNextAction(
      state([item(34, { phase: "ticketed", triageState: "ready-for-agent" })]),
    );
    expect(recommendation?.bucket).toBe("implementation-frontier");
    expect(recommendation?.command).toBe("/implement");
    expect(recommendation?.primary).toBe("/implement #34");
    expect(recommendation?.issueId).toBe("GH-34");
    expect(recommendation?.reason).toContain("implementation frontier");
  });

  it("reads the in-flight bucket first: reviewing, then implementing, then claimed", () => {
    const recommendation = recommendNextAction(
      state([
        item(34, { phase: "ticketed", triageState: "ready-for-agent" }),
        item(58, { assignees: ["vvaz"], phase: "implementing" }),
        item(65, { assignees: ["vvaz"], phase: "reviewing" }),
        item(64, { assignees: ["vvaz"], triageState: "ready-for-agent" }),
      ]),
    );
    expect(recommendation?.bucket).toBe("in-flight");
    expect(recommendation?.issueId).toBe("GH-65");
    expect(recommendation?.command).toBe("/code-review");
    expect(recommendation?.primary).toBe("/code-review #65");
    expect(recommendation?.reason).toContain("in-flight");
  });

  it("recommends resuming implementing in-flight work", () => {
    const recommendation = recommendNextAction(
      state([
        item(34, { phase: "ticketed", triageState: "ready-for-agent" }),
        item(58, { assignees: ["vvaz"], phase: "implementing" }),
      ]),
    );
    expect(recommendation?.bucket).toBe("in-flight");
    expect(recommendation?.issueId).toBe("GH-58");
    expect(recommendation?.command).toBe("/implement");
    expect(recommendation?.primary).toBe("/implement #58");
  });

  it("marks claimed-but-not-started in-flight work informational, with no command", () => {
    const recommendation = recommendNextAction(
      state([
        item(34, { phase: "ticketed", triageState: "ready-for-agent" }),
        item(64, { assignees: ["vvaz"], triageState: "ready-for-agent" }),
      ]),
    );
    expect(recommendation?.bucket).toBe("in-flight");
    expect(recommendation?.issueId).toBe("GH-64");
    expect(recommendation?.command).toBeNull();
    expect(recommendation?.primary).toContain("#64");
    expect(recommendation?.reason).toContain("in-flight");
    expect(recommendation?.reason).toContain("informational");
  });

  it("skips needs-info, ready-for-human, deferred, wontfix, and shipped work", () => {
    const recommendation = recommendNextAction(
      state([
        item(13, { phase: "ticketed", triageState: "ready-for-agent" }),
        item(37, { assignees: ["vvaz"], phase: "implementing", triageState: "needs-info" }),
        item(38, { assignees: ["vvaz"], phase: "implementing", triageState: "ready-for-human" }),
        item(24, { assignees: ["vvaz"], phase: "implementing", deferred: true }),
        item(39, { assignees: ["vvaz"], phase: "implementing", triageState: "wontfix" }),
        item(12, { assignees: ["vvaz"], phase: "shipped", triageState: "ready-for-agent" }),
      ]),
    );
    expect(recommendation?.issueId).toBe("GH-13");
  });

  it("skips implementation-frontier items that are gated, parked, or refused", () => {
    const recommendation = recommendNextAction(
      state([
        item(37, { phase: "ticketed", triageState: "ready-for-agent", deferred: true }),
        item(38, { phase: "ticketed", triageState: "ready-for-human" }),
        item(39, { phase: "ticketed", triageState: "needs-info" }),
        item(40, { phase: "ticketed", triageState: "wontfix" }),
        item(34, { phase: "ticketed", triageState: "ready-for-agent" }),
      ]),
    );
    expect(recommendation?.issueId).toBe("GH-34");
  });

  it("recommends the map frontier head in map order, with the kind's skill", () => {
    const recommendation = recommendNextAction(
      state(
        [
          item(44, { kind: "task" }),
          item(43, { kind: "grilling" }),
          item(42, { kind: "research" }),
          item(41, { kind: "map" }),
        ],
        [map(41, [42, 43, 44])],
      ),
    );
    expect(recommendation?.bucket).toBe("map-frontier");
    expect(recommendation?.issueId).toBe("GH-42");
    expect(recommendation?.command).toBe("/research");
    expect(recommendation?.primary).toBe("/research #42");
    expect(recommendation?.reason).toContain("map frontier");
  });

  it("names the per-kind working skill across the decision-ticket kinds", () => {
    const perKind = (kind: WorkItemRecord["kind"]) =>
      recommendNextAction(state([item(50, { kind })], [map(41, [50])]))?.command;
    expect(perKind("research")).toBe("/research");
    expect(perKind("prototype")).toBe("/prototype");
    expect(perKind("grilling")).toBe("/grilling");
    expect(perKind("task")).toBe("/wayfinder");
  });

  it("skips gated map-frontier tickets and lets an open blocker hold its dependent back", () => {
    const recommendation = recommendNextAction(
      state(
        [
          item(42, { kind: "research", triageState: "needs-info" }),
          item(43, { kind: "grilling", deferred: true }),
          item(44, { kind: "task" }),
          item(45, { kind: "prototype" }),
          item(41, { kind: "map" }),
        ],
        [map(41, [42, 43, 44, 45])],
        [edge(44, 45)],
      ),
    );
    expect(recommendation?.issueId).toBe("GH-45");
    expect(recommendation?.command).toBe("/prototype");
  });

  it("skips mapped implementation work in the map frontier — it is not a decision ticket", () => {
    const recommendation = recommendNextAction(
      state(
        [
          item(42, { kind: "task" }),
          item(43, { phase: "ticketed", triageState: "needs-triage" }),
          item(41, { kind: "map" }),
        ],
        [map(41, [43, 42])],
      ),
    );
    expect(recommendation?.bucket).toBe("map-frontier");
    expect(recommendation?.issueId).toBe("GH-42");
  });

  it("recommends /to-tickets on an effort sitting at specced (flow advance)", () => {
    const recommendation = recommendNextAction(
      state([item(41, { kind: "map", phase: "specced" })], [map(41, [])]),
    );
    expect(recommendation?.bucket).toBe("flow-advance");
    expect(recommendation?.issueId).toBe("GH-41");
    expect(recommendation?.command).toBe("/to-tickets");
    expect(recommendation?.primary).toBe("/to-tickets #41");
    expect(recommendation?.reason).toContain("flow advance");
  });

  it("skips a gated or parked specced effort in the flow-advance bucket", () => {
    const recommendation = recommendNextAction(
      state(
        [
          item(41, { kind: "map", phase: "specced", triageState: "ready-for-human" }),
          item(47, { kind: "map", phase: "specced", deferred: true }),
          item(50, { kind: "map", phase: "specced" }),
        ],
        [map(41, []), map(47, []), map(50, [])],
      ),
    );
    expect(recommendation?.issueId).toBe("GH-50");
  });

  it("recommends /triage on the intake head, map children excluded (triage intake)", () => {
    const recommendation = recommendNextAction(
      state(
        [
          item(1, { triageState: "needs-triage" }),
          item(69, { triageState: "needs-triage" }),
          item(42, { kind: "research", triageState: "needs-triage", state: "closed" }),
        ],
        [map(41, [42])],
      ),
    );
    expect(recommendation?.bucket).toBe("triage-intake");
    expect(recommendation?.issueId).toBe("GH-1");
    expect(recommendation?.command).toBe("/triage");
    expect(recommendation?.primary).toBe("/triage #1");
    expect(recommendation?.reason).toContain("triage intake");
  });

  it("returns the head of the first non-empty bucket across the whole table", () => {
    const recommendation = recommendNextAction(
      state(
        [
          item(1, { triageState: "needs-triage" }),
          item(34, { phase: "ticketed", triageState: "ready-for-agent" }),
          item(50, { kind: "research" }),
          item(41, { kind: "map", phase: "specced" }),
        ],
        [map(41, [50])],
      ),
    );
    expect(recommendation?.bucket).toBe("implementation-frontier");
    expect(recommendation?.issueId).toBe("GH-34");
  });

  it("returns null when every bucket is empty", () => {
    expect(recommendNextAction(state([item(13, { triageState: "needs-info" })]))).toBeNull();
    expect(recommendNextAction(state([]))).toBeNull();
  });

  it("orders in-flight claims by map order before issue number within a row", () => {
    const recommendation = recommendNextAction(
      state(
        [
          item(9, { assignees: ["matt"], phase: "implementing" }),
          item(42, { assignees: ["vvaz"], phase: "implementing" }),
        ],
        [map(41, [42])],
      ),
    );
    expect(recommendation?.issueId).toBe("GH-42");
  });
  it("holds a ticketed map out of the implementation frontier — a map is not implement work", () => {
    const recommendation = recommendNextAction(
      state(
        [item(41, { kind: "map", phase: "ticketed", triageState: "ready-for-agent" })],
        [map(41, [])],
      ),
    );
    expect(recommendation).toBeNull();
  });

  it("tiebreaks the implementation frontier by map order before issue number", () => {
    const recommendation = recommendNextAction(
      state(
        [
          item(42, { phase: "ticketed", triageState: "ready-for-agent" }),
          item(43, { phase: "ticketed", triageState: "ready-for-agent" }),
        ],
        [map(41, [43, 42])],
      ),
    );
    expect(recommendation?.bucket).toBe("implementation-frontier");
    expect(recommendation?.issueId).toBe("GH-43");
  });

  it("tiebreaks the triage-intake head by issue number ascending", () => {
    const recommendation = recommendNextAction(
      state([item(69, { triageState: "needs-triage" }), item(1, { triageState: "needs-triage" })]),
    );
    expect(recommendation?.bucket).toBe("triage-intake");
    expect(recommendation?.issueId).toBe("GH-1");
  });
});

describe("the repo-wide frontier strip", () => {
  it("lists each map's grabbable head in map order plus the unmapped bucket", () => {
    const strip = frontierStrip(
      state(
        [
          item(44, { kind: "task" }),
          item(43, { kind: "grilling" }),
          item(42, { kind: "research" }),
          item(34, { phase: "ticketed", triageState: "ready-for-agent" }),
          item(41, { kind: "map" }),
        ],
        [map(41, [42, 43, 44])],
      ),
    );
    expect(strip.maps.map(({ map: entry }) => entry.mapId)).toEqual(["GH-41"]);
    expect(strip.maps[0]?.head?.id).toBe("GH-42");
    expect(strip.unmapped.map((record) => record.id)).toEqual(["GH-34"]);
  });

  it("carries every map, even one with nothing grabbable", () => {
    const strip = frontierStrip(
      state(
        [item(42, { kind: "research", assignees: ["vvaz"] }), item(41, { kind: "map" })],
        [map(41, [42])],
      ),
    );
    expect(strip.maps).toHaveLength(1);
    expect(strip.maps[0]?.head).toBeNull();
    expect(strip.unmapped).toEqual([]);
  });

  it("holds blocked unmapped work off the strip — the strip is grabbable work", () => {
    const strip = frontierStrip(
      state(
        [
          item(34, { phase: "ticketed", triageState: "ready-for-agent" }),
          item(35, { assignees: ["vvaz"] }),
          item(36, { phase: "ticketed", triageState: "ready-for-agent" }),
        ],
        [],
        [edge(34, 35)],
      ),
    );
    expect(strip.unmapped.map((record) => record.id)).toEqual(["GH-36"]);
  });

  it("fails closed on dangling blocker references — a typo'd gate never ungates", () => {
    const strip = frontierStrip(
      state([item(34, { phase: "ticketed", triageState: "ready-for-agent" })], [], [edge(34, 999)]),
    );
    expect(strip.unmapped).toEqual([]);
  });
});
