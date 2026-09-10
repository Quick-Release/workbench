import { Waypoints } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  GraphView,
  type GraphEdgeDatum,
  type GraphLabelDatum,
  type GraphNodeDatum,
} from "@/components/GraphView";
import {
  layoutBlockerGraph,
  blockerOrders,
  type BlockerBox,
  type BlockerLayoutNode,
} from "@/lib/blocker-layout";
import { mapGraph, emptyStateFor, whyNotLine } from "@/lib/blockers";
import { indexWorkItems, openBlockers } from "@/lib/frontier";
import { workItemIdLabel } from "@/lib/work-item-id";
import type { BlockerEdgeRecord, TrackerMapRecord, WorkItemRecord } from "@/types";

type BlockersPageProps = {
  maps: readonly TrackerMapRecord[];
  workItems: readonly WorkItemRecord[];
  blockerEdges: readonly BlockerEdgeRecord[];
  /** The map's id from the `?map` param; null falls back to map order. */
  mapId: string | null;
  /** The focused node's id from the `?focus` param — the show-in-graph target. */
  focusId: string | null;
  expandClosed: boolean;
  onMapChange: (mapId: string) => void;
  onExpandClosedChange: (expanded: boolean) => void;
  onOpenIssue: (issueId: string) => void;
};

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

// Edge geometry from the prototype: a cubic from the blocker's right edge to
// the blocked ticket's left edge, whatever the ranks say.
const blockerEdgePath = (from: BlockerBox, to: BlockerBox): string => {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
};

const EMPTY_COPY: Record<"all-clear" | "in-flight" | "stuck-blocked", string> = {
  "all-clear": "All clear — every ticket in this map has closed.",
  "in-flight": " claimed — the work is in flight, not grabbable.",
  "stuck-blocked": "Nothing grabbable — open work waits on its gates.",
};

// The blocker graph view (ticket #61): the approved prototype ported behind
// the GraphView seam — depth columns with blockers left and blocked right,
// the edge grammar (solid amber open gates, dashed gray satisfied, dashed
// red broken), a why-not-grabbable line on every non-frontier node, closed
// history contracted until the expand toggle opens it, and dangling
// references rendered fail-closed as warning nodes.
export function BlockersPage({
  maps,
  workItems,
  blockerEdges,
  mapId,
  focusId,
  expandClosed,
  onMapChange,
  onExpandClosedChange,
  onOpenIssue,
}: BlockersPageProps) {
  const map =
    maps.find((candidate) => candidate.mapId === mapId) ?? (mapId === null ? maps[0] : undefined);

  const header = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Waypoints className="size-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Blockers</h1>
        </div>
        <div className="flex items-center gap-2">
          <NativeSelect
            aria-label="Map"
            className="w-64 text-xs"
            value={map?.mapId ?? mapId ?? ""}
            onChange={(event) => onMapChange(event.target.value)}
          >
            {map ? null : <option value={mapId ?? ""}>{mapId ?? "—"}</option>}
            {maps.map((candidate) => (
              <option key={candidate.mapId} value={candidate.mapId}>
                {candidate.mapId} · {truncate(candidate.title, 36)}
              </option>
            ))}
          </NativeSelect>
          <Button
            size="sm"
            variant={expandClosed ? "secondary" : "outline"}
            aria-pressed={expandClosed}
            onClick={() => onExpandClosedChange(!expandClosed)}
          >
            Expand closed
          </Button>
        </div>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Each map's gate chain at a glance — blockers left, blocked right, the grabbable frontier
        highlighted. A reference no collected record covers renders as broken: it counts open, so a
        typo'd gate can never silently ungate work.
      </p>
    </>
  );

  if (!map) {
    return (
      <div className="flex flex-col gap-6 p-6">
        {header}
        <p className="text-sm text-muted-foreground" role="status">
          {maps.length === 0
            ? "No wayfinder map in the snapshot — sync a host repo with a wayfinder:map issue and its gate chain renders here."
            : `The snapshot carries no such map — ${mapId} matches no map.`}
        </p>
      </div>
    );
  }

  const graph = mapGraph(map, workItems, blockerEdges, maps);
  const layout = layoutBlockerGraph({
    nodes: graph.nodes,
    // Dangling pairs ride along so the layout places their warning nodes —
    // they contribute no rank, only the fail-closed marker.
    edges: [...graph.edges, ...graph.dangling],
    orders: blockerOrders(map.ticketIds, graph.nodes),
    expandClosed,
  });
  const memberNodes = graph.nodes.filter((node) => map.ticketIds.includes(node.id));
  const emptyState = emptyStateFor(memberNodes, graph.memberFrontierIds);
  const warningBoxes = new Map(layout.warnings.map((warning) => [warning.blockerId, warning.box]));
  const positionOf = (id: string): BlockerBox | undefined =>
    layout.positions[id] ?? warningBoxes.get(id);
  const blockerIndex = indexWorkItems(workItems);

  const nodes: GraphNodeDatum[] = graph.nodes.map((node: BlockerLayoutNode) => {
    const box = layout.positions[node.id];
    const label = workItemIdLabel(node.id);
    const record = workItems.find((item) => item.id === node.id);
    const whyNot = whyNotLine(node.id, workItems, blockerEdges, graph.frontierIds);
    if (node.closed) {
      return {
        id: node.id,
        box,
        label: expandClosed
          ? `${label} ${truncate(record?.title ?? "", 20)}`
          : `${label} · ${truncate(record?.title ?? "", 16)} ✓`,
        sublabel: expandClosed ? "CLOSED ✓" : undefined,
        accent: "var(--line-strong)",
        dimmed: true,
        selected: focusId === node.id,
        title: `${node.id} — ${whyNot}`,
        onSelect: () => onOpenIssue(node.id),
      };
    }
    // The gate counts derive from the full edge list — open gates and broken
    // references name themselves apart, so a broken ref never masquerades as
    // a real gate.
    const { open: openGates, dangling: brokenGates } = openBlockers(
      node.id,
      blockerEdges,
      blockerIndex,
    );
    let sublabel: string;
    if (graph.frontierIds.has(node.id)) sublabel = "GRABBABLE";
    else if (node.claimed) sublabel = `@${record?.assignees.join(", @").toUpperCase()}`;
    else if (openGates.length > 0) sublabel = `BLOCKED BY ${openGates.length}`;
    else if (brokenGates.length > 0) sublabel = "BROKEN GATE";
    else sublabel = "WAITING";
    const grabbable = graph.frontierIds.has(node.id);
    return {
      id: node.id,
      box,
      label: `${label} ${truncate(record?.title ?? "", 20)}`,
      sublabel,
      accent: grabbable ? "var(--good)" : node.claimed ? "var(--blue)" : "var(--line-strong)",
      frontier: grabbable,
      selected: focusId === node.id,
      title: `${node.id} — ${whyNot}`,
      onSelect: () => onOpenIssue(node.id),
    };
  });

  for (const warning of layout.warnings) {
    nodes.push({
      id: warning.blockerId,
      box: warning.box,
      label: `⚠ ${workItemIdLabel(warning.blockerId)} unknown reference`,
      sublabel: "COUNTS OPEN · FAIL-CLOSED",
      accent: "var(--coral)",
      broken: true,
      title: `${warning.blockerId} — no such ticket exists; the edge pointing here fails closed (ADR 0008).`,
      onSelect: () => onOpenIssue(warning.blockerId),
    });
  }

  const edges: GraphEdgeDatum[] = graph.edges.map((candidate) => {
    const blocker = graph.nodes.find((node) => node.id === candidate.blockerId);
    const variant =
      blocker?.closed === true ? "gate-satisfied" : ("gate-open" as GraphEdgeDatum["variant"]);
    return {
      id: `${candidate.blockerId}->${candidate.blockedId}`,
      d: blockerEdgePath(
        layout.positions[candidate.blockerId],
        layout.positions[candidate.blockedId],
      ),
      variant,
      title: `${candidate.blockerId} gates ${candidate.blockedId}`,
    };
  });
  for (const dangling of graph.dangling) {
    const from = positionOf(dangling.blockerId);
    const to = layout.positions[dangling.blockedId];
    if (!from || !to) continue;
    edges.push({
      id: `${dangling.blockerId}->${dangling.blockedId}`,
      d: blockerEdgePath(from, to),
      variant: "gate-broken",
      title: `${dangling.blockerId} is no collected record — the gate on ${dangling.blockedId} fails closed`,
    });
  }

  const ranks = [...new Set(graph.nodes.map((node) => layout.positions[node.id]?.rank ?? 0))].sort(
    (left, right) => left - right,
  );
  const labels: GraphLabelDatum[] = [
    { x: 36, y: 20, text: `${map.mapId} · ${map.title}` },
    { x: 36, y: 34, text: "blockers left · blocked right — map membership is order, not edges" },
    ...ranks.map((rank) => ({
      x: 36 + rank * 388,
      y: 52,
      text: `DEPTH ${rank}${rank === 0 ? " · NO BLOCKERS" : ""}`,
    })),
  ];

  const claimedIds = graph.nodes
    .filter((node) => !node.closed && node.claimed)
    .map((node) => node.id)
    .join(", ");

  return (
    <div className="flex flex-col gap-6 p-6">
      {header}
      {emptyState && (
        <p
          data-slot="blockers-empty"
          data-empty={emptyState}
          className="text-sm text-muted-foreground"
          role="status"
        >
          {emptyState === "in-flight"
            ? `${claimedIds}${EMPTY_COPY[emptyState]}`
            : EMPTY_COPY[emptyState]}
        </p>
      )}
      <figure className="min-w-0">
        <GraphView
          width={layout.width}
          height={layout.height}
          ariaLabel={`Blocker graph of ${map.mapId} — ${map.title}`}
          labels={labels}
          edges={edges}
          nodes={nodes}
        />
      </figure>
      {focusId && layout.positions[focusId] && (
        <p data-slot="blockers-focus-note" className="text-sm" role="status">
          <strong>{focusId}</strong> —{" "}
          {whyNotLine(focusId, workItems, blockerEdges, graph.frontierIds)}
        </p>
      )}
      <p data-slot="blockers-legend" className="text-xs text-muted-foreground">
        solid — open gate · dashed gray — satisfied · dashed red — broken (fail-closed) · green —
        frontier, grabbable now
      </p>
    </div>
  );
}
