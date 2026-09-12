import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { BlockerEdgeRecord, WorkItemRecord } from "../types";
import { board } from "../lib/board";
import { BoardPage } from "./BoardPage";

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

const fixtureItems: WorkItemRecord[] = [
  item(70, { kind: "research", title: "How should the board place planning work?" }),
  item(8, { phase: "implementing", title: "Build the board columns" }),
  item(24, { phase: "ticketed", deferred: true, title: "Parked swimlane idea" }),
  item(65, { state: "closed", phase: "shipped", stateReason: "completed", title: "Shipped work" }),
];

const columnsOf = (overrides: Partial<Parameters<typeof board>[0]> = {}) =>
  board({ workItems: fixtureItems, blockerEdges: [], maps: [], ...overrides });

const renderPage = (
  columns = columnsOf(),
  overrides: Partial<Parameters<typeof BoardPage>[0]> = {},
) =>
  renderToString(
    <BoardPage
      columns={columns}
      deferredLens={false}
      mode="live"
      pendingId={null}
      message={null}
      onLensChange={() => {}}
      onOpenIssue={() => {}}
      onMovePhase={() => {}}
      {...overrides}
    />,
  );

const withoutComments = (html: string) => html.replace(/<!-- -->/g, "");

describe("the board page", () => {
  it("renders the eight flow columns in order with their counts", () => {
    const html = withoutComments(renderPage());
    expect(html).toContain("pre-flow");
    for (const phase of [
      "grilling",
      "prototyping",
      "specced",
      "ticketed",
      "implementing",
      "reviewing",
      "shipped",
    ])
      expect(html).toContain(phase);
    expect(html.match(/data-slot="board-column"/g)?.length).toBe(8);
  });

  it("renders cards with their id, title, and decision-ticket kind", () => {
    const html = withoutComments(renderPage());
    expect(html).toContain('data-slot="board-card"');
    expect(html).toContain("GH-8");
    expect(html).toContain("Build the board columns");
    expect(html).toContain('data-column="grilling"');
    expect(html).toContain("How should the board place planning work?");
    expect(html).toContain('data-slot="board-kind"');
    expect(html).toContain("research");
  });

  it("marks grabbable and blocked cards from the computed edges", () => {
    const columns = columnsOf({
      blockerEdges: [edge("GH-8", "GH-70")],
      workItems: fixtureItems,
    });
    const html = withoutComments(renderPage(columns));
    expect(html).toContain("grabbable");
    expect(html).toContain("blocked");
  });

  it("hides parked work until the deferred lens opens, then parks it in place", () => {
    const plain = withoutComments(renderPage());
    expect(plain).not.toContain("Parked swimlane idea");
    expect(plain).not.toContain("parked");

    const throughLens = withoutComments(
      renderPage(columnsOf({ deferredLens: true }), { deferredLens: true }),
    );
    expect(throughLens).toContain("Parked swimlane idea");
    expect(throughLens).toContain("parked");
    expect(throughLens).toContain('data-column="ticketed"');
  });

  it("renders closed decision-ticket outcomes as decided or ruled out", () => {
    const columns = columnsOf({
      workItems: [
        item(70, { kind: "grilling", state: "closed", stateReason: "completed" }),
        item(71, { kind: "prototype", state: "closed", stateReason: "not_planned" }),
      ],
    });
    const html = withoutComments(renderPage(columns));
    expect(html).toContain("decided");
    expect(html).toContain("ruled out");
  });

  it("renders a double-label warning on the card it describes", () => {
    const warnings = [
      'GH-8: workflow labels "workflow:implementing", "workflow:reviewing" resolve to the furthest-along phase "reviewing"',
      "tracker: some map members were not read; their work-item records may be missing",
    ];
    const columns = columnsOf({ warnings });
    const html = withoutComments(renderPage(columns));
    expect(html).toContain('data-slot="board-card-warning"');
    expect(html).toContain("resolve to the furthest-along phase");
    expect(html).not.toContain("map members were not read");
  });

  it("renders claim chips without moving columns", () => {
    const columns = columnsOf({
      workItems: [item(70, { kind: "research", assignees: ["vvaz"] })],
    });
    const html = withoutComments(renderPage(columns));
    expect(html).toContain("claimed");
    expect(html).toContain('data-column="grilling"');
  });

  it("renders caveat lines on the cards they describe", () => {
    const columns = columnsOf({
      workItems: [item(12, { phase: "shipped" })],
    });
    const html = withoutComments(renderPage(columns));
    expect(html).toContain("still open — both facts shown");
  });

  it("renders an honest empty line in a column with no cards", () => {
    const columns = columnsOf({ workItems: [] });
    const html = withoutComments(renderPage(columns));
    expect(html.match(/data-slot="board-empty"/g)?.length).toBe(8);
  });

  it("offers a move select on the card, excluding its current column", () => {
    const columns = columnsOf({ workItems: [item(8, { phase: "implementing" })] });
    const html = withoutComments(renderPage(columns));
    expect(html).toContain('aria-label="Move GH-8"');
    expect(html).toContain('<option value="pre-flow"');
    expect(html).toContain('<option value="reviewing"');
    expect(html).not.toContain('<option value="implementing"');
  });

  it("degrades the card's move to the command composer in static mode", () => {
    const columns = columnsOf({ workItems: [item(8, { phase: "implementing" })] });
    const html = withoutComments(renderPage(columns, { mode: "static" }));
    expect(html).toContain('aria-label="Compose a move command for GH-8"');
    expect(html).not.toContain('aria-label="Move GH-8"');
  });

  it("marks the card whose move is in flight", () => {
    const columns = columnsOf({ workItems: [item(8, { phase: "implementing" })] });
    const html = withoutComments(renderPage(columns, { pendingId: "GH-8" }));
    expect(html).toContain("Moving");
    expect(html).not.toContain('aria-label="Move GH-8"');
  });

  it("offers no phase move on a decision ticket — placement is the table's, not labels'", () => {
    const columns = columnsOf({ workItems: [item(70, { kind: "task" })] });
    const html = withoutComments(renderPage(columns));
    expect(html).not.toContain('aria-label="Move GH-70"');
    expect(html).toContain("place by the placement table");
  });
});

describe("the board's time-in-phase lines (#149)", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");

  it("renders the time in phase on a clocked card", () => {
    const columns = columnsOf({
      workItems: [item(8, { phase: "implementing", phaseSince: "2026-09-08T12:00:00.000Z" })],
      now,
    });
    const html = withoutComments(renderPage(columns));
    expect(html).toContain('data-slot="board-clock"');
    expect(html).toContain("4d in implementing");
  });

  it("renders the last-touched fallback and no clock for decision tickets or pre-flow", () => {
    const columns = columnsOf({
      workItems: [
        item(9, { phase: "ticketed", updatedAt: "2026-09-12T09:00:00.000Z" }),
        item(70, { kind: "task" }),
        item(11, {}),
      ],
      now,
    });
    const html = withoutComments(renderPage(columns));
    expect(html).toContain("last touched 3h ago");
    expect(html.match(/data-slot="board-clock"/g)?.length).toBe(1);
  });
});
