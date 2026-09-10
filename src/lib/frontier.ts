import type { BlockerEdgeRecord, TrackerMapRecord, WorkItemRecord } from "../types";
import { byMapOrderThenNumber, mapOrderIndex } from "./map-order";

// ADR 0008: the frontier selector runs over the tracker's work items.
export type FrontierItem = {
  id: string;
  open: boolean;
  assignees: readonly string[];
};

export type ItemsById = Map<string, FrontierItem>;

export const frontierItemFromWorkItem = (record: WorkItemRecord): FrontierItem => ({
  id: record.id,
  open: record.state === "open",
  assignees: record.assignees,
});

export const itemsById = (items: readonly FrontierItem[]): ItemsById =>
  new Map(items.map((item) => [item.id, item]));

/** The blocker-lookup index over work-item records, built once per list. */
export const indexWorkItems = (workItems: readonly WorkItemRecord[]): ItemsById =>
  itemsById(workItems.map(frontierItemFromWorkItem));

// ADR 0008: a dangling blocker — an edge whose endpoint no collected record
// covers — counts as open, so a typo'd gate can never silently ungate work.
export const openBlockers = (
  id: string,
  edges: readonly BlockerEdgeRecord[],
  items: ItemsById,
): { open: string[]; dangling: string[] } => {
  const open: string[] = [];
  const dangling: string[] = [];
  for (const edge of edges) {
    if (edge.blockedId !== id) continue;
    const blocker = items.get(edge.blockerId);
    if (!blocker) dangling.push(edge.blockerId);
    else if (blocker.open) open.push(edge.blockerId);
  }
  return { open, dangling };
};

// The frontier is computed, never stored: open ∧ unassigned ∧ all blockers
// closed, closed-is-closed. Map children keep their map order ("first in map
// order wins"); everything else falls back to issue number ascending.
export const frontier = (
  workItems: readonly FrontierItem[],
  blockerEdges: readonly BlockerEdgeRecord[],
  maps: readonly TrackerMapRecord[],
): FrontierItem[] => {
  const byId = itemsById(workItems);
  const compare = byMapOrderThenNumber(mapOrderIndex(maps));

  const grabbable = workItems.filter((item) => {
    if (!item.open || item.assignees.length > 0) return false;
    const { open, dangling } = openBlockers(item.id, blockerEdges, byId);
    return open.length === 0 && dangling.length === 0;
  });

  return grabbable.sort((left, right) => compare(left.id, right.id));
};

// The "show in graph" map an item belongs to (ticket #60's detail grammar):
// its map, when it is a map child. Anything else — edge participants outside
// a map — names no map the snapshot can prove; the blocker graph's ticket
// owns the wider graph semantics.
export const mapFor = (issueId: string, maps: readonly TrackerMapRecord[]): string | null =>
  maps.find((map) => map.ticketIds.includes(issueId))?.mapId ?? null;
