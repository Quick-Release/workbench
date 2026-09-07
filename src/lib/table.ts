import {
  createSortedRowModel,
  rowSortingFeature,
  sortFn_basic,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * Shared TanStack Table feature set: column sorting backed by a sorted row
 * model. Tables that only need core rendering can use `tableFeatures({})`
 * instead; anything that sorts should reuse this object so sorted columns
 * stay consistent across tables.
 */
export const sortableTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic },
});

export type SortableTableFeatures = typeof sortableTableFeatures;
