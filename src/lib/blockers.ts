import type { BlockerEdgeRecord, TrackerMapRecord, WorkItemRecord } from "../types";
import { frontierItemFromWorkItem, frontier, itemsById, openBlockers } from "./frontier";
import type { BlockerEdgePair, BlockerLayoutNode } from "./blocker-layout";

// The blocker graph's derivation (ticket #61): what the per-effort canvas
// shows, the why-not-grabbable line on every non-frontier node, and the
// three-way empty split. Pure over the workflow state; rendering consumes
// the results verbatim.

export type EffortDangling = { blockedId: string; blockerId: string };

export type EffortGraph = {
  nodes: BlockerLayoutNode[];
  edges: BlockerEdgePair[];
  dangling: EffortDangling[];
  /** Grabbable nodes on the canvas — members and their gates alike (ADR 0008's frontier is not map-scoped). */
  frontierIds: Set<string>;
  /** Grabbable members only — the effort's own frontier, the empty banner's input. */
  memberFrontierIds: Set<string>;
};

// The canvas's scope: the effort map's members plus every known gate they
// declare, edges into members, and unknown references kept as fail-closed
// dangling warnings (ADR 0008) so a typo'd gate shows as broken, never as
// silently ungating work.
export const effortGraph = (
  map: TrackerMapRecord,
  workItems: readonly WorkItemRecord[],
  blockerEdges: readonly BlockerEdgeRecord[],
  maps: readonly TrackerMapRecord[],
): EffortGraph => {
  const members = new Set(map.ticketIds);
  const byId = itemsById(workItems.map(frontierItemFromWorkItem));

  const edges: BlockerEdgePair[] = [];
  const dangling: EffortDangling[] = [];
  const gateIds = new Set<string>();
  for (const record of blockerEdges) {
    if (!members.has(record.blockedId)) continue;
    if (byId.has(record.blockerId)) {
      edges.push({ blockedId: record.blockedId, blockerId: record.blockerId });
      gateIds.add(record.blockerId);
    } else {
      dangling.push({ blockedId: record.blockedId, blockerId: record.blockerId });
    }
  }

  const nodeFrom = (id: string): BlockerLayoutNode | null => {
    const record = byId.get(id);
    return record ? { id, closed: !record.open, claimed: record.assignees.length > 0 } : null;
  };
  const nodes: BlockerLayoutNode[] = [];
  for (const id of map.ticketIds) {
    const node = nodeFrom(id);
    if (node) nodes.push(node);
  }
  for (const id of gateIds) {
    if (members.has(id)) continue;
    const node = nodeFrom(id);
    if (node) nodes.push(node);
  }

  const grabbable = new Set(
    frontier(workItems.map(frontierItemFromWorkItem), blockerEdges, maps).map((item) => item.id),
  );
  const canvasIds = new Set(nodes.map((node) => node.id));
  const frontierIds = new Set([...grabbable].filter((id) => canvasIds.has(id)));
  const memberFrontierIds = new Set([...grabbable].filter((id) => members.has(id)));

  return { nodes, edges, dangling, frontierIds, memberFrontierIds };
};

// The why-not-grabbable grammar from the approved prototype: closed dismisses
// in one line, a claim names its claimer, open gates and broken references
// name their ids — the broken kind with its fail-closed marking — and a
// grabbable ticket says so. Rendered on every non-frontier node (story 22).
export const whyNotLine = (
  issueId: string,
  workItems: readonly WorkItemRecord[],
  blockerEdges: readonly BlockerEdgeRecord[],
  frontierIds: Set<string>,
): string => {
  if (frontierIds.has(issueId)) return "Grabbable now — all blockers closed, nobody assigned.";
  const record = workItems.find((item) => item.id === issueId);
  if (!record || record.state === "closed") return "Closed.";
  if (record.assignees.length > 0)
    return `Not grabbable — claimed by ${record.assignees.map((a) => `@${a}`).join(", ")}.`;

  const byId = itemsById(workItems.map(frontierItemFromWorkItem));
  const { open, dangling } = openBlockers(issueId, blockerEdges, byId);
  const bits: string[] = [];
  if (open.length > 0) bits.push(`blocked by ${open.length} open (${open.join(", ")})`);
  if (dangling.length > 0)
    bits.push(
      `${dangling.length} broken reference${dangling.length === 1 ? "" : "s"} (${dangling.join(", ")}) — counts open, fail-closed`,
    );
  return bits.length > 0 ? `Not grabbable — ${bits.join(" · ")}.` : "Not grabbable.";
};

// The canvas empties three ways (story 25): all-clear when no open work
// remains, in-flight when the only open work is claimed, stuck-blocked when
// open unclaimed work exists but nothing is grabbable. A non-empty frontier
// is not an empty state at all.
export type BlockerEmptyState = "all-clear" | "in-flight" | "stuck-blocked";

export const emptyStateFor = (
  nodes: readonly BlockerLayoutNode[],
  frontierIds: Set<string>,
): BlockerEmptyState | null => {
  if (frontierIds.size > 0) return null;
  const open = nodes.filter((node) => !node.closed);
  if (open.length === 0) return "all-clear";
  return open.every((node) => node.claimed) ? "in-flight" : "stuck-blocked";
};
