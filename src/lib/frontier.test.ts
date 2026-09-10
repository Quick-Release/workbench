import { describe, expect, it } from "vite-plus/test";

import type { BlockerEdgeRecord, TrackerMapRecord, WorkItemRecord } from "../types";
import {
  frontier,
  frontierItemFromWorkItem,
  mapFor,
  openBlockers,
  type FrontierItem,
} from "./frontier";

const workItem = (id: string, overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id,
  title: `Work item ${id}`,
  url: `https://github.com/example/project/issues/${id.slice(3)}`,
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

const edge = (
  blockedId: string,
  blockerId: string,
  source: BlockerEdgeRecord["source"] = "github-native",
): BlockerEdgeRecord => ({
  blockedId,
  blockerId,
  source,
  sourceRef: `https://github.com/example/project/issues/${blockedId.slice(3)}`,
});

const mapWith = (mapId: string, ticketIds: string[]): TrackerMapRecord => ({
  mapId,
  title: `Map ${mapId}`,
  url: `https://github.com/example/project/issues/${mapId.slice(3)}`,
  ticketIds,
});

const byId = (items: FrontierItem[]) => new Map(items.map((item) => [item.id, item]));

describe("frontier selector", () => {
  it("names an open, unassigned item whose blockers are all closed", () => {
    const items = [
      frontierItemFromWorkItem(workItem("GH-1")),
      frontierItemFromWorkItem(workItem("GH-2", { state: "closed", phase: "shipped" })),
    ];
    const edges = [edge("GH-1", "GH-2")];

    expect(frontier(items, edges, [])).toEqual([items[0]]);
  });

  it("excludes assigned, closed, and open-blocked items", () => {
    const items = [
      frontierItemFromWorkItem(workItem("GH-1")),
      frontierItemFromWorkItem(workItem("GH-2", { assignees: ["vvaz"] })),
      frontierItemFromWorkItem(workItem("GH-3", { state: "closed", phase: "shipped" })),
      frontierItemFromWorkItem(workItem("GH-4")),
      frontierItemFromWorkItem(workItem("GH-5")),
    ];
    const edges = [edge("GH-4", "GH-5")];

    expect(frontier(items, edges, []).map((item) => item.id)).toEqual(["GH-1", "GH-5"]);
  });

  it("treats a dangling blocker as open — fail closed", () => {
    const items = [frontierItemFromWorkItem(workItem("GH-1"))];
    const edges = [edge("GH-1", "GH-999")];

    expect(frontier(items, edges, [])).toEqual([]);
    expect(openBlockers("GH-1", edges, byId(items))).toEqual({ open: [], dangling: ["GH-999"] });
  });

  it("keeps an item with no edges grabbable and closed blockers satisfied", () => {
    const items = [
      frontierItemFromWorkItem(workItem("GH-1")),
      frontierItemFromWorkItem(workItem("GH-2", { state: "closed", phase: "shipped" })),
      frontierItemFromWorkItem(workItem("GH-3", { state: "closed", phase: "shipped" })),
    ];
    const edges = [edge("GH-1", "GH-2"), edge("GH-1", "GH-3"), edge("GH-2", "GH-3")];

    expect(frontier(items, edges, []).map((item) => item.id)).toEqual(["GH-1"]);
    expect(openBlockers("GH-1", edges, byId(items))).toEqual({ open: [], dangling: [] });
  });

  it("gates on direct blockers only — a closed blocker's own history does not matter", () => {
    const items = [
      frontierItemFromWorkItem(workItem("GH-1")),
      frontierItemFromWorkItem(workItem("GH-2", { state: "closed", phase: "shipped" })),
      frontierItemFromWorkItem(workItem("GH-3")),
    ];
    const edges = [edge("GH-1", "GH-2"), edge("GH-3", "GH-2")];

    expect(frontier(items, edges, []).map((item) => item.id)).toEqual(["GH-1", "GH-3"]);
  });

  it("orders map children in map order ahead of unmapped items in number order", () => {
    const items = ["GH-9", "GH-7", "GH-3", "GH-8"].map((id) =>
      frontierItemFromWorkItem(workItem(id)),
    );
    const maps = [mapWith("GH-100", ["GH-8", "GH-3"])];

    expect(frontier(items, [], maps).map((item) => item.id)).toEqual([
      "GH-8",
      "GH-3",
      "GH-7",
      "GH-9",
    ]);
  });
});

describe("mapFor", () => {
  const maps: TrackerMapRecord[] = [
    {
      mapId: "GH-41",
      title: "Skills-ecosystem dashboard",
      url: "https://github.com/example/project/issues/41",
      ticketIds: ["GH-42", "GH-43"],
    },
  ];

  it("names a map child's map", () => {
    expect(mapFor("GH-42", maps)).toBe("GH-41");
  });

  it("names no map for an item outside every map", () => {
    expect(mapFor("GH-60", maps)).toBeNull();
  });
});
