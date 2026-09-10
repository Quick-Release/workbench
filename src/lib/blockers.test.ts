import { describe, expect, it } from "vite-plus/test";

import type { BlockerEdgeRecord, TrackerMapRecord, WorkItemRecord } from "../types";
import { emptyStateFor, mapGraph, whyNotLine } from "./blockers";

const item = (number: number, overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
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

const edge = (blocked: number, blocker: number): BlockerEdgeRecord => ({
  blockedId: `GH-${blocked}`,
  blockerId: `GH-${blocker}`,
  source: "github-native",
  sourceRef: "",
});

const map: TrackerMapRecord = {
  mapId: "GH-41",
  title: "Skills-ecosystem dashboard",
  url: "https://github.com/Quick-Release/workbench/issues/41",
  ticketIds: ["GH-42", "GH-51", "GH-53"],
};

describe("mapGraph", () => {
  it("scopes the canvas to the map's members plus their declared gates", () => {
    // GH-53 is gated by member GH-51 and by GH-7, which is no member — the
    // gate chain renders, the outsider renders as a node.
    const workItems = [item(42), item(51, { state: "closed" }), item(53), item(7)];
    const graph = mapGraph(map, workItems, [edge(53, 51), edge(53, 7), edge(9, 8)], []);
    expect(graph.nodes.map((node) => node.id)).toEqual(["GH-42", "GH-51", "GH-53", "GH-7"]);
    expect(graph.edges).toEqual([
      { blockedId: "GH-53", blockerId: "GH-51" },
      { blockedId: "GH-53", blockerId: "GH-7" },
    ]);
  });

  it("renders a declared-but-unknown blocker as a dangling warning, fail-closed", () => {
    const workItems = [item(53)];
    const graph = mapGraph(map, workItems, [edge(53, 99)], []);
    expect(graph.nodes.map((node) => node.id)).toEqual(["GH-53"]);
    expect(graph.dangling).toEqual([{ blockedId: "GH-53", blockerId: "GH-99" }]);
  });

  it("marks the frontier: open, unassigned, every blocker closed", () => {
    const workItems = [
      item(42, { state: "closed" }),
      item(51, { assignees: ["vvaz"] }),
      item(53),
      item(7, { state: "closed" }),
    ];
    const graph = mapGraph(map, workItems, [edge(53, 7)], []);
    expect(graph.frontierIds).toEqual(new Set(["GH-53"]));
    expect(graph.memberFrontierIds).toEqual(new Set(["GH-53"]));
  });

  it("marks a grabbable gate outside the map as frontier on the canvas, not in the map", () => {
    // GH-7 gates GH-53 and is itself open, unassigned, and unblocked —
    // grabbable work per ADR 0008 even though it is no map member.
    const workItems = [item(53, { state: "closed" }), item(7)];
    const graph = mapGraph(map, workItems, [edge(53, 7)], []);
    expect(graph.frontierIds).toEqual(new Set(["GH-7"]));
    expect(graph.memberFrontierIds).toEqual(new Set());
  });
});

describe("whyNotLine", () => {
  it("names the open gates of a blocked ticket", () => {
    const workItems = [item(53), item(51), item(47)];
    const line = whyNotLine("GH-53", workItems, [edge(53, 51), edge(53, 47)], new Set([]));
    expect(line).toBe("Not grabbable — blocked by 2 open (GH-51, GH-47).");
  });

  it("names a broken reference as counting open, fail-closed", () => {
    const workItems = [item(53)];
    const line = whyNotLine("GH-53", workItems, [edge(53, 99)], new Set([]));
    expect(line).toBe("Not grabbable — 1 broken reference (GH-99) — counts open, fail-closed.");
  });

  it("joins both facts when a ticket is blocked and broken at once", () => {
    const workItems = [item(53), item(51)];
    const line = whyNotLine("GH-53", workItems, [edge(53, 51), edge(53, 99)], new Set([]));
    expect(line).toBe(
      "Not grabbable — blocked by 1 open (GH-51) · 1 broken reference (GH-99) — counts open, fail-closed.",
    );
  });

  it("names the claim on claimed work", () => {
    const workItems = [item(51, { assignees: ["vvaz"] })];
    const line = whyNotLine("GH-51", workItems, [], new Set([]));
    expect(line).toBe("Not grabbable — claimed by @vvaz.");
  });

  it("answers the grabbable ticket with the frontier line", () => {
    const workItems = [item(53)];
    const line = whyNotLine("GH-53", workItems, [], new Set(["GH-53"]));
    expect(line).toBe("Grabbable now — all blockers closed, nobody assigned.");
  });

  it("dismisses closed history in one line", () => {
    const workItems = [item(42, { state: "closed" })];
    const line = whyNotLine("GH-42", workItems, [], new Set([]));
    expect(line).toBe("Closed.");
  });
});

describe("emptyStateFor", () => {
  const nodes = [
    { id: "GH-42", closed: true, claimed: false },
    { id: "GH-51", closed: false, claimed: true },
  ];

  it("splits all-clear when no open work remains", () => {
    expect(emptyStateFor([{ id: "GH-42", closed: true }], new Set())).toBe("all-clear");
  });

  it("splits in-flight when the only open work is claimed", () => {
    expect(emptyStateFor(nodes, new Set())).toBe("in-flight");
  });

  it("splits stuck-blocked when open unclaimed work has no grabbable head", () => {
    const gated = [
      { id: "GH-51", closed: false, claimed: true },
      { id: "GH-53", closed: false, claimed: false },
    ];
    expect(emptyStateFor(gated, new Set())).toBe("stuck-blocked");
  });

  it("is null while the frontier is non-empty", () => {
    expect(emptyStateFor(nodes, new Set(["GH-51"]))).toBeNull();
  });
});
