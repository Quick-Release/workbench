import {
  createSortedRowModel,
  rowSortingFeature,
  sortFn_basic,
  tableFeatures,
} from "@tanstack/react-table";
import type { Row } from "@tanstack/react-table";

import { ticketStatuses, type TicketStatus } from "../types";

/**
 * Shared TanStack Table feature set: column sorting backed by a sorted row
 * model. Tables that only need core rendering can use `tableFeatures({})`
 * instead; anything that sorts should reuse this object so status columns
 * stay consistent across tables.
 */
export const sortableTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic },
});

export type SortableTableFeatures = typeof sortableTableFeatures;

/**
 * Sorts status values in canonical lifecycle order (ready, in-progress,
 * gated, ...) rather than alphabetically.
 */
export function statusSortFn<TData extends { status: TicketStatus }>(
  rowA: Row<SortableTableFeatures, TData>,
  rowB: Row<SortableTableFeatures, TData>,
  columnId: string,
): number {
  return (
    ticketStatuses.indexOf(rowA.getValue<TicketStatus>(columnId)) -
    ticketStatuses.indexOf(rowB.getValue<TicketStatus>(columnId))
  );
}
