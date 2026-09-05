import type { BlockerEdgeRecord, TicketRecord, TrackerMapRecord, WorkItemRecord } from "../types";

// ADR 0008: the frontier selector runs over tickets from every source —
// tracker work items and ledger ticket records alike. A source without an
// assignee concept is vacuously unclaimed; complete is a ledger ticket's
// closed.
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

export const frontierItemFromTicket = (record: TicketRecord): FrontierItem => ({
  id: record.id,
  open: record.status !== "complete",
  assignees: [],
});

export const itemsById = (items: readonly FrontierItem[]): ItemsById =>
  new Map(items.map((item) => [item.id, item]));

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
  tickets: readonly FrontierItem[],
  blockerEdges: readonly BlockerEdgeRecord[],
  maps: readonly TrackerMapRecord[],
): FrontierItem[] => {
  const byId = itemsById(tickets);
  const mapOrder = new Map<string, number>();
  for (const map of maps) {
    for (const ticketId of map.ticketIds)
      if (!mapOrder.has(ticketId)) mapOrder.set(ticketId, mapOrder.size);
  }

  const grabbable = tickets.filter((item) => {
    if (!item.open || item.assignees.length > 0) return false;
    const { open, dangling } = openBlockers(item.id, blockerEdges, byId);
    return open.length === 0 && dangling.length === 0;
  });

  const numberSuffix = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1)) || 0;
  return grabbable.sort((left, right) => {
    const leftOrder = mapOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = mapOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || numberSuffix(left.id) - numberSuffix(right.id);
  });
};
