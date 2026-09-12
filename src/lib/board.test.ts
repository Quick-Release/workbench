import { describe, expect, it } from "vite-plus/test";

import type { BlockerEdgeRecord, DecisionPlacementRow, WorkItemRecord } from "../types";
import { board, boardColumnFor, boardColumns, DEFAULT_DECISION_PLACEMENT } from "./board";

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

const edge = (blockedId: string, blockerId: string): BlockerEdgeRecord => ({
  blockedId,
  blockerId,
  source: "blocked-by-line",
  sourceRef: `https://github.com/Quick-Release/workbench/issues/${blockedId}`,
});

const cardsIn = (column: string, columns: ReturnType<typeof board>) =>
  columns.find((entry) => entry.key === column)?.cards ?? [];

const idsIn = (column: string, columns: ReturnType<typeof board>) =>
  cardsIn(column, columns).map((card) => card.record.id);

const cardFor = (id: string, columns: ReturnType<typeof board>) => {
  const card = columns.flatMap((entry) => entry.cards).find((card) => card.record.id === id);
  expect(card).toBeTruthy();
  return card!;
};

const boardOf = (
  workItems: readonly WorkItemRecord[],
  overrides: Partial<Parameters<typeof board>[0]> = {},
) =>
  board({
    workItems,
    blockerEdges: [],
    maps: [],
    ...overrides,
  });

describe("board columns", () => {
  it("are pre-flow plus the seven phases in flow order", () => {
    expect([...boardColumns]).toEqual([
      "pre-flow",
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

describe("board placement", () => {
  it("places a regular work item by its resolved phase", () => {
    const columns = boardOf([item(7, { phase: "implementing" })]);
    expect(idsIn("implementing", columns)).toEqual(["GH-7"]);
  });

  it("sits a triaged item with no phase label in pre-flow, not in the flow", () => {
    const columns = boardOf([
      item(7, { triageState: "ready-for-agent" }),
      item(9, { triageState: "needs-info" }),
    ]);
    expect(idsIn("pre-flow", columns)).toEqual(["GH-7", "GH-9"]);
    expect(
      columns
        .filter((entry) => entry.key !== "pre-flow")
        .flatMap((entry) => entry.cards.map((card) => card.record.id)),
    ).toEqual([]);
  });

  it("places an open decision ticket by the placement table's open column", () => {
    const columns = boardOf([
      item(70, { kind: "grilling" }),
      item(71, { kind: "research" }),
      item(72, { kind: "prototype" }),
      item(73, { kind: "task" }),
    ]);
    expect(idsIn("grilling", columns)).toEqual(["GH-70", "GH-71"]);
    expect(idsIn("prototyping", columns)).toEqual(["GH-72"]);
    expect(idsIn("ticketed", columns)).toEqual(["GH-73"]);
  });

  it("places a closed decision ticket in shipped regardless of kind", () => {
    const columns = boardOf([
      item(70, { kind: "grilling", state: "closed", stateReason: "completed" }),
      item(72, { kind: "prototype", state: "closed", stateReason: "not_planned" }),
      item(73, { kind: "task", state: "closed" }),
    ]);
    expect(idsIn("shipped", columns)).toEqual(["GH-70", "GH-72", "GH-73"]);
    expect(idsIn("grilling", columns)).toEqual([]);
  });

  it("honors a parsed placement table passed in and falls back to pre-flow for an unlisted kind", () => {
    const placement: DecisionPlacementRow[] = [
      { kind: "research", openColumn: "specced", closedColumn: "reviewing" },
    ];
    const columns = boardOf([item(70, { kind: "research" }), item(71, { kind: "grilling" })], {
      decisionPlacement: placement,
    });
    expect(idsIn("specced", columns)).toEqual(["GH-70"]);
    expect(idsIn("pre-flow", columns)).toEqual(["GH-71"]);
  });

  it("carries the canonical table as the default", () => {
    expect(DEFAULT_DECISION_PLACEMENT).toEqual([
      { kind: "grilling", openColumn: "grilling", closedColumn: "shipped" },
      { kind: "research", openColumn: "grilling", closedColumn: "shipped" },
      { kind: "prototype", openColumn: "prototyping", closedColumn: "shipped" },
      { kind: "task", openColumn: "ticketed", closedColumn: "shipped" },
    ]);
  });

  it("places a map by its own phase like any work item", () => {
    const columns = boardOf([item(90, { kind: "map", phase: "specced" })]);
    expect(idsIn("specced", columns)).toEqual(["GH-90"]);
  });

  it("keeps a decision ticket's claimed chip from moving its column", () => {
    const columns = boardOf([item(70, { kind: "research", assignees: ["vvaz"] })]);
    expect(idsIn("grilling", columns)).toEqual(["GH-70"]);
    expect(cardFor("GH-70", columns).chips.claimed).toBe(true);
    expect(cardFor("GH-70", columns).chips.grabbable).toBe(false);
  });

  it("places by the table, not by a worn phase label, for decision tickets", () => {
    expect(boardColumnFor(item(70, { kind: "task", phase: "implementing" }))).toBe("ticketed");
  });
});

describe("board chips", () => {
  it("marks blocked when an open blocker edge names the card", () => {
    const columns = boardOf([item(7), item(8)], { blockerEdges: [edge("GH-7", "GH-8")] });
    expect(cardFor("GH-7", columns).chips.blocked).toBe(true);
    expect(cardFor("GH-8", columns).chips.blocked).toBe(false);
  });

  it("treats a dangling blocker as blocked, fail-closed", () => {
    const columns = boardOf([item(7)], { blockerEdges: [edge("GH-7", "GH-999")] });
    expect(cardFor("GH-7", columns).chips.blocked).toBe(true);
    expect(cardFor("GH-7", columns).chips.grabbable).toBe(false);
  });

  it("marks grabbable exactly the frontier: open, unclaimed, all blockers closed", () => {
    const columns = boardOf(
      [
        item(7), // blocked by the claimed GH-9
        item(8), // grabbable
        item(9, { assignees: ["vvaz"] }), // claimed
        item(10, { state: "closed", phase: "shipped" }), // closed
      ],
      { blockerEdges: [edge("GH-7", "GH-9")] },
    );
    expect(cardFor("GH-7", columns).chips.grabbable).toBe(false);
    expect(cardFor("GH-8", columns).chips.grabbable).toBe(true);
    expect(cardFor("GH-9", columns).chips.grabbable).toBe(false);
    expect(cardFor("GH-10", columns).chips.grabbable).toBe(false);
  });

  it("lets a closed shipped blocker satisfy a gate: the blocked card is grabbable", () => {
    const columns = boardOf([item(8)], {
      blockerEdges: [edge("GH-8", "GH-10")],
      recentlyShipped: [item(10, { state: "closed", phase: "shipped" })],
    });
    expect(cardFor("GH-8", columns).chips.blocked).toBe(false);
    expect(cardFor("GH-8", columns).chips.grabbable).toBe(true);
  });

  it("chips a closed decision ticket decided or ruled out by why it closed", () => {
    const columns = boardOf([
      item(70, { kind: "grilling", state: "closed", stateReason: "completed" }),
      item(72, { kind: "prototype", state: "closed", stateReason: "not_planned" }),
      item(73, { kind: "task", state: "closed" }),
    ]);
    expect(cardFor("GH-70", columns).chips.decided).toBe(true);
    expect(cardFor("GH-70", columns).chips.ruledOut).toBe(false);
    expect(cardFor("GH-72", columns).chips.ruledOut).toBe(true);
    expect(cardFor("GH-72", columns).chips.decided).toBe(false);
    expect(cardFor("GH-73", columns).chips.decided).toBe(false);
    expect(cardFor("GH-73", columns).chips.ruledOut).toBe(false);
  });

  it("never chips decided or ruled out on an open decision ticket or a regular item", () => {
    const columns = boardOf([item(70, { kind: "grilling" }), item(8)]);
    expect(cardFor("GH-70", columns).chips.decided).toBe(false);
    expect(cardFor("GH-8", columns).chips.ruledOut).toBe(false);
  });
});

describe("the deferred lens", () => {
  it("keeps parked work out of the columns — never a ninth column", () => {
    const columns = boardOf([item(24, { deferred: true, phase: "ticketed" })]);
    expect(columns.map((entry) => entry.key)).toHaveLength(8);
    expect(columns.flatMap((entry) => entry.cards.map((card) => card.record.id))).toEqual([]);
  });

  it("parks the card in place behind the lens, in its placed column", () => {
    const columns = boardOf([item(24, { deferred: true, phase: "ticketed" })], {
      deferredLens: true,
    });
    expect(idsIn("ticketed", columns)).toEqual(["GH-24"]);
    expect(cardFor("GH-24", columns).chips.parked).toBe(true);
  });
});

describe("the shipped page merge", () => {
  it("lands recently shipped work in the shipped column", () => {
    const columns = boardOf([item(7, { phase: "grilling" })], {
      recentlyShipped: [item(65, { state: "closed", phase: "shipped", stateReason: "completed" })],
    });
    expect(idsIn("shipped", columns)).toEqual(["GH-65"]);
  });

  it("prefers the work-item record when an id rides in both lists", () => {
    const columns = boardOf([item(65, { state: "closed", phase: "shipped", summary: "held" })], {
      recentlyShipped: [item(65, { state: "closed", phase: "shipped", summary: "paged" })],
    });
    expect(cardFor("GH-65", columns).record.summary).toBe("held");
    expect(idsIn("shipped", columns)).toEqual(["GH-65"]);
  });

  it("lets a recently shipped record satisfy another card's gate", () => {
    const columns = boardOf([item(8)], {
      recentlyShipped: [item(10, { state: "closed", phase: "shipped" })],
      blockerEdges: [edge("GH-8", "GH-10")],
    });
    expect(cardFor("GH-8", columns).chips.grabbable).toBe(true);
  });
});

describe("caveats and warnings", () => {
  it("renders the show-with-caveat lines on the cards they describe", () => {
    const columns = boardOf([
      item(12, { phase: "shipped" }), // shipped but open
      item(13, { phase: "ticketed", state: "closed" }), // closed without shipped
    ]);
    expect(cardFor("GH-12", columns).caveats.map((caveat) => caveat.kind)).toEqual([
      "shipped-open",
    ]);
    expect(cardFor("GH-13", columns).caveats.map((caveat) => caveat.kind)).toEqual([
      "closed-without-shipped",
    ]);
  });

  it("attaches the payload's double-label warning to the card its id prefixes", () => {
    const warnings = [
      'GH-54: workflow labels "workflow:ticketed", "workflow:specced" resolve to the furthest-along phase "specced"',
      "tracker: some map members were not read; their work-item records may be missing",
    ];
    const columns = boardOf([item(54, { phase: "specced" }), item(8)], { warnings });
    expect(cardFor("GH-54", columns).warnings).toEqual([warnings[0]]);
    expect(cardFor("GH-8", columns).warnings).toEqual([]);
  });
});

describe("card order", () => {
  it("is issue number ascending within a column", () => {
    const columns = boardOf([
      item(9, { phase: "implementing" }),
      item(7, { phase: "implementing" }),
    ]);
    expect(idsIn("implementing", columns)).toEqual(["GH-7", "GH-9"]);
  });
});

describe("the client-side placement fallback", () => {
  it("mirrors the tracker's default — one table, two readers, no drift", async () => {
    // The doc home is parsed at sync (scripts/tracker/labels.mjs); the client
    // fallback only covers snapshots that predate the table riding the
    // payload. Equality is pinned here so the two readers cannot drift.
    const { DEFAULT_DECISION_PLACEMENT: trackerDefault } = await import(
      // @ts-expect-error scripts/*.mjs carry no type declarations
      "../../scripts/tracker/labels.mjs"
    );
    expect(trackerDefault).toEqual(DEFAULT_DECISION_PLACEMENT);
  });
});
