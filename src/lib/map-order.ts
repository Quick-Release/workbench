import type { TrackerMapRecord } from "../types";
import { workItemIdNumber } from "./work-item-id";

// Map membership is order, not edges (ADR 0008): "first in map order wins" —
// a member's position is its map's ticketIds index, first map to claim the id
// keeps it. The shared tiebreak comparator sorts ids by that position and
// falls back to issue number ascending for everything unmapped.
export const mapOrderIndex = (maps: readonly TrackerMapRecord[]): Map<string, number> => {
  const order = new Map<string, number>();
  for (const map of maps)
    for (const ticketId of map.ticketIds) if (!order.has(ticketId)) order.set(ticketId, order.size);
  return order;
};

// The all-unmapped fallback: issue number ascending, then the id text, so
// two same-numbered ids from different namespaces still order
// deterministically.
export const byNumberThenId = (left: string, right: string): number =>
  workItemIdNumber(left) - workItemIdNumber(right) || left.localeCompare(right);

export const byMapOrderThenNumber =
  (order: ReadonlyMap<string, number>) =>
  (left: string, right: string): number =>
    (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER) ||
    byNumberThenId(left, right);
