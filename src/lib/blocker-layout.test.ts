import { describe, expect, it } from "vite-plus/test";

import {
  blockerOrders,
  blockerRanks,
  layoutBlockerGraph,
  type BlockerLayoutNode,
} from "./blocker-layout";

// The real 12-edge graph — map GH-41's decision tickets and their native
// blocked-by edges as transcribed for the approved prototype (issue #51).
const REAL_ORDER = [
  "GH-42",
  "GH-43",
  "GH-44",
  "GH-45",
  "GH-46",
  "GH-47",
  "GH-48",
  "GH-49",
  "GH-50",
  "GH-51",
  "GH-52",
  "GH-53",
] as const;

const REAL_EDGES = (
  [
    ["GH-50", "GH-43"],
    ["GH-50", "GH-45"],
    ["GH-51", "GH-43"],
    ["GH-51", "GH-47"],
    ["GH-52", "GH-42"],
    ["GH-52", "GH-46"],
    ["GH-52", "GH-47"],
    ["GH-52", "GH-48"],
    ["GH-52", "GH-49"],
    ["GH-53", "GH-50"],
    ["GH-53", "GH-51"],
    ["GH-53", "GH-52"],
  ] as const
).map(([blockedId, blockerId]) => ({ blockedId, blockerId }));

const openNodes = (ids: readonly string[]): BlockerLayoutNode[] =>
  ids.map((id) => ({ id, closed: false }));

describe("blockerRanks", () => {
  it("ranks the real 12-edge graph by longest path: seven roots, three mid, one tail", () => {
    const ranks = blockerRanks(openNodes(REAL_ORDER), REAL_EDGES);
    expect(ranks.get("GH-42")).toBe(0);
    expect(ranks.get("GH-47")).toBe(0);
    expect(ranks.get("GH-50")).toBe(1);
    expect(ranks.get("GH-51")).toBe(1);
    expect(ranks.get("GH-52")).toBe(1);
    expect(ranks.get("GH-53")).toBe(2);
  });

  it("ranks the longest chain, not the first found", () => {
    const ranks = blockerRanks(openNodes(["GH-1", "GH-2", "GH-3"]), [
      { blockedId: "GH-3", blockerId: "GH-2" },
      { blockedId: "GH-3", blockerId: "GH-1" },
      { blockedId: "GH-2", blockerId: "GH-1" },
    ]);
    expect(ranks.get("GH-1")).toBe(0);
    expect(ranks.get("GH-2")).toBe(1);
    expect(ranks.get("GH-3")).toBe(2);
  });

  it("survives a cycle deterministically instead of recursing forever", () => {
    const ranks = blockerRanks(openNodes(["GH-1", "GH-2"]), [
      { blockedId: "GH-1", blockerId: "GH-2" },
      { blockedId: "GH-2", blockerId: "GH-1" },
    ]);
    // A cycle has no depth order to expose: every member ranks 0, and sync
    // warns about the cycle separately (ADR 0008 — nothing auto-broken).
    expect(ranks.get("GH-1")).toBe(0);
    expect(ranks.get("GH-2")).toBe(0);
  });
});

describe("blockerOrders", () => {
  it("orders a layer by map order, not issue number", () => {
    const orders = blockerOrders(["GH-45", "GH-42"], openNodes(["GH-42", "GH-45"]));
    expect(orders["GH-45"]).toBeLessThan(orders["GH-42"]);
  });

  it("orders non-members after every member by issue number", () => {
    const orders = blockerOrders(["GH-53"], openNodes(["GH-53", "GH-7", "GH-10"]));
    expect(orders["GH-53"]).toBeLessThan(orders["GH-7"]);
    expect(orders["GH-7"]).toBeLessThan(orders["GH-10"]);
  });
});

describe("layoutBlockerGraph", () => {
  it("places the real graph in three depth columns, blockers left of blocked", () => {
    const layout = layoutBlockerGraph({
      nodes: openNodes(REAL_ORDER),
      edges: REAL_EDGES,
      orders: blockerOrders([...REAL_ORDER], openNodes(REAL_ORDER)),
    });
    expect(layout.positions["GH-47"].x).toBeLessThan(layout.positions["GH-51"].x);
    expect(layout.positions["GH-51"].x).toBeLessThan(layout.positions["GH-53"].x);
    expect(Object.keys(layout.positions).length).toBe(12);
  });

  it("is deterministic for identical input", () => {
    const first = layoutBlockerGraph({
      nodes: openNodes(REAL_ORDER),
      edges: REAL_EDGES,
      orders: blockerOrders([...REAL_ORDER], openNodes(REAL_ORDER)),
    });
    const second = layoutBlockerGraph({
      nodes: openNodes(REAL_ORDER),
      edges: REAL_EDGES,
      orders: blockerOrders([...REAL_ORDER], openNodes(REAL_ORDER)),
    });
    expect(first).toEqual(second);
  });

  it("stacks a wide layer without overlap and grows the canvas", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `GH-${index + 1}`);
    const layout = layoutBlockerGraph({ nodes: openNodes(ids), edges: [], orders: {} });
    const ys = ids.map((id) => layout.positions[id].y);
    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index]).toBeGreaterThan(ys[index - 1]);
    }
    expect(layout.height).toBeGreaterThan(716);
  });

  it("stacks a wide layer in within-layer order, map order before issue number", () => {
    const layout = layoutBlockerGraph({
      nodes: openNodes(["GH-5", "GH-2", "GH-9"]),
      edges: [],
      orders: blockerOrders(["GH-9", "GH-5"], openNodes(["GH-5", "GH-2", "GH-9"])),
    });
    expect(layout.positions["GH-9"].y).toBeLessThan(layout.positions["GH-5"].y);
    expect(layout.positions["GH-5"].y).toBeLessThan(layout.positions["GH-2"].y);
  });

  it("contracts closed nodes until the expand toggle opens them", () => {
    const nodes: BlockerLayoutNode[] = [
      { id: "GH-1", closed: true },
      { id: "GH-2", closed: false },
    ];
    const contracted = layoutBlockerGraph({ nodes, edges: [], orders: {} });
    const expanded = layoutBlockerGraph({ nodes, edges: [], orders: {}, expandClosed: true });
    expect(contracted.positions["GH-1"].h).toBeLessThan(contracted.positions["GH-2"].h);
    expect(expanded.positions["GH-1"].h).toBeGreaterThan(contracted.positions["GH-1"].h);
    expect(expanded.positions["GH-1"].h).toBeLessThan(expanded.positions["GH-2"].h);
  });

  it("gives a dangling blocker its own warning node left of the blocked ticket", () => {
    const layout = layoutBlockerGraph({
      nodes: openNodes(["GH-2", "GH-3"]),
      edges: [
        { blockedId: "GH-3", blockerId: "GH-2" },
        { blockedId: "GH-3", blockerId: "GH-99" },
      ],
      orders: {},
    });
    expect(layout.positions["GH-99"]).toBeUndefined();
    expect(layout.warnings.length).toBe(1);
    expect(layout.warnings[0].blockerId).toBe("GH-99");
    // The warning node occupies the blocker's would-be column: one left of
    // the ticket it gates, stacked below that column's own tier.
    expect(layout.warnings[0].box.x).toBe(layout.positions["GH-2"].x);
    expect(layout.warnings[0].box.x).toBeLessThan(layout.positions["GH-3"].x);
    expect(layout.warnings[0].box.y).toBeGreaterThan(
      layout.positions["GH-2"].y + layout.positions["GH-2"].h,
    );
  });
});
