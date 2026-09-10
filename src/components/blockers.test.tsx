import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { focusParamFromSearch, mapParamFromSearch } from "../lib/issue-param";
import type { BlockerEdgeRecord, TrackerMapRecord, WorkItemRecord } from "../types";
import { BlockersPage } from "./BlockersPage";

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
  ticketIds: ["GH-42", "GH-51", "GH-52", "GH-53"],
};

const page = (maps = [map]) =>
  ({
    maps,
    workItems: [
      item(42, { state: "closed" as const }),
      item(51, { assignees: ["vvaz"] }),
      item(52),
      item(53),
    ],
    blockerEdges: [edge(52, 42), edge(52, 51), edge(53, 99)],
    mapId: maps[0]?.mapId ?? null,
    focusId: null,
    expandClosed: false,
    onMapChange: () => {},
    onExpandClosedChange: () => {},
    onOpenIssue: () => {},
  }) as Parameters<typeof BlockersPage>[0];

describe("the blocker graph view", () => {
  it("renders one node per member and gate plus a warning node per dangling reference", () => {
    const html = renderToString(<BlockersPage {...page()} />);
    expect(html.match(/data-slot="graph-node"/g)?.length).toBe(5);
    expect(html.match(/data-slot="graph-edge"/g)?.length).toBe(3);
    expect(html).toContain("GH-99");
    expect(html).toContain("unknown reference");
  });

  it("renders the edge grammar: solid open gates, dashed satisfied, dashed broken", () => {
    const html = renderToString(<BlockersPage {...page()} />);
    // GH-51 is open: its gate on GH-52 renders open; GH-42 is closed:
    // satisfied; GH-99 never existed: broken.
    expect(html).toContain("graph-edge-gate-open");
    expect(html).toContain("graph-edge-gate-satisfied");
    expect(html).toContain("graph-edge-gate-broken");
  });

  it("highlights the frontier green and answers it with the grabbable line", () => {
    const frontier = page();
    frontier.blockerEdges = [];
    frontier.workItems = [item(53), item(51, { assignees: ["vvaz"] })];
    const html = renderToString(<BlockersPage {...frontier} />);
    expect(html).toContain("graph-node-frontier");
    expect(html).toContain("Grabbable now — all blockers closed, nobody assigned.");
  });

  it("contracts closed tickets until the expand toggle opens them", () => {
    const html = renderToString(<BlockersPage {...page()} />);
    const closedRect = /data-id="GH-42"[\s\S]*?height="(\d+)"/.exec(html);
    const openRect = /data-id="GH-51"[\s\S]*?height="(\d+)"/.exec(html);
    expect(Number(closedRect?.[1])).toBe(24);
    expect(Number(openRect?.[1])).toBe(58);
    const expanded = page();
    expanded.expandClosed = true;
    const expandedHtml = renderToString(<BlockersPage {...expanded} />);
    expect(expandedHtml).toContain("CLOSED ✓");
    expect(Number(/data-id="GH-42"[\s\S]*?height="(\d+)"/.exec(expandedHtml)?.[1])).toBe(48);
  });

  it("carries a why-not-grabbable line on every non-frontier node", () => {
    const html = renderToString(<BlockersPage {...page()} />);
    expect(html).toContain("GH-52 — Not grabbable — blocked by 1 open (GH-51).");
    expect(html).toContain("GH-42 — Closed.");
    expect(html).toContain("GH-51 — Not grabbable — claimed by @vvaz.");
    expect(html).toContain(
      "GH-53 — Not grabbable — 1 broken reference (GH-99) — counts open, fail-closed.",
    );
  });

  it("splits the empty canvas three ways", () => {
    const allClear = page();
    allClear.workItems = [item(42, { state: "closed" as const })];
    allClear.blockerEdges = [];
    const allClearHtml = renderToString(<BlockersPage {...allClear} />);
    expect(allClearHtml).toContain('data-empty="all-clear"');

    const inFlight = page();
    inFlight.workItems = [item(51, { assignees: ["vvaz"] })];
    inFlight.blockerEdges = [];
    const inFlightHtml = renderToString(<BlockersPage {...inFlight} />);
    expect(inFlightHtml).toContain('data-empty="in-flight"');
    expect(inFlightHtml).toContain("GH-51");

    const stuck = page();
    const stuckHtml = renderToString(<BlockersPage {...stuck} />);
    expect(stuckHtml).toContain('data-empty="stuck-blocked"');

    // A non-empty frontier is not an empty state at all.
    const grabbable = page();
    grabbable.blockerEdges = [];
    grabbable.workItems = [item(53)];
    const grabbableHtml = renderToString(<BlockersPage {...grabbable} />);
    expect(grabbableHtml).not.toContain("data-empty=");
  });

  it("highlights the node the focus param names and prints its why-not line", () => {
    const focused = page();
    focused.focusId = "GH-52";
    const html = renderToString(<BlockersPage {...focused} />);
    expect(
      /data-id="GH-52"[^>]*"[^>]*graph-node-selected|graph-node-selected[\s\S]*data-id="GH-52"/.test(
        html,
      ),
    ).toBe(true);
    expect(html).toContain("GH-52 — Not grabbable — blocked by 1 open (GH-51).");
  });

  it("highlights a grabbable gate from outside the map as frontier, not broken", () => {
    // A non-member gate that is itself grabbable is frontier work, never a
    // broken gate — the frontier is not map-scoped (ADR 0008).
    const outsider = page();
    outsider.workItems = [
      item(42, { state: "closed" as const }),
      item(51, { assignees: ["vvaz"] }),
      item(52),
      item(53, { state: "closed" as const }),
      item(7),
    ];
    outsider.blockerEdges = [edge(52, 7)];
    const html = renderToString(<BlockersPage {...outsider} />);
    expect(/data-id="GH-7"[^>]*graph-node-frontier/.test(html)).toBe(true);
    expect(html).toContain("Grabbable now — all blockers closed, nobody assigned.");
  });

  it("lands the shared panel's show-in-graph link with the node focused", () => {
    // The panel's href (ticket #60) is `/blockers?map=GH-41&focus=42`;
    // feeding that query through the view's param grammar must select the
    // map and focus the node.
    const search = Object.fromEntries(new URLSearchParams({ map: "GH-41", focus: "42" }));
    const mapId = mapParamFromSearch(search);
    const focusId = focusParamFromSearch(search);
    expect(mapId).toBe("GH-41");
    expect(focusId).toBe("GH-42");
    const jumped = page();
    jumped.mapId = mapId ?? null;
    jumped.focusId = focusId ?? null;
    const html = renderToString(<BlockersPage {...jumped} />);
    expect(/data-id="GH-42"[^>]*graph-node-selected/.test(html)).toBe(true);
  });

  it("renders depth column captions and the map's name", () => {
    const html = renderToString(<BlockersPage {...page()} />);
    expect(html).toContain("DEPTH 0");
    expect(html).toContain("Skills-ecosystem dashboard");
    expect(html).toContain("blockers left · blocked right");
  });

  it("names the maps in the map picker and flags a map the snapshot does not carry", () => {
    const html = renderToString(<BlockersPage {...page()} />);
    expect(html).toContain("GH-41");

    const unknown = page();
    unknown.mapId = "GH-999";
    const unknownHtml = renderToString(<BlockersPage {...unknown} />);
    expect(unknownHtml).toContain("GH-999");
    expect(unknownHtml).toContain("no such map");
  });
});
