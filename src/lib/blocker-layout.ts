// The blocker DAG's layout, ported from the approved prototype (decision
// ticket #51) behind the GraphView seam: pure, deterministic functions over
// the graph shape — longest-path ranking into depth columns (blockers left,
// blocked right), within-layer stacking in map order. The sanctioned dagre
// swap-in replaces only this module, never the views.

import type { BlockerEdgeRecord } from "../types";

export type BlockerLayoutNode = {
  id: string;
  closed: boolean;
  claimed?: boolean;
};

export type BlockerEdgePair = Pick<BlockerEdgeRecord, "blockedId" | "blockerId">;

const numberSuffix = (id: string) => Number(id.slice(id.lastIndexOf("-") + 1)) || 0;

// Longest-path ranking over real edges only — a dangling edge names no
// endpoint to traverse, so it contributes no rank (its blocker renders as a
// warning node beside the column instead). Cycles have no depth order to
// expose: every edge whose blocker reaches back to the blocked ticket drops
// first, so the members of a declared cycle rank as if unblocked by each
// other and the computation stays finite; sync warns about the cycle
// separately (ADR 0008). Effort graphs are small (≤ ~50 nodes), so plain
// reachability checks carry the cycle detection.
export const blockerRanks = (
  nodes: readonly BlockerLayoutNode[],
  edges: readonly BlockerEdgePair[],
): Map<string, number> => {
  const known = new Set(nodes.map((node) => node.id));
  const blockersOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (!known.has(edge.blockedId) || !known.has(edge.blockerId)) continue;
    if (!blockersOf.has(edge.blockedId)) blockersOf.set(edge.blockedId, []);
    blockersOf.get(edge.blockedId)!.push(edge.blockerId);
  }

  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const frontier = [from];
    while (frontier.length > 0) {
      const current = frontier.pop()!;
      for (const blocker of blockersOf.get(current) ?? []) {
        if (blocker === to) return true;
        if (!seen.has(blocker)) {
          seen.add(blocker);
          frontier.push(blocker);
        }
      }
    }
    return false;
  };

  const acyclicBlockersOf = new Map<string, string[]>();
  for (const [blockedId, blockers] of blockersOf) {
    acyclicBlockersOf.set(
      blockedId,
      blockers.filter((blockerId) => !reaches(blockerId, blockedId)),
    );
  }

  const ranks = new Map<string, number>();
  const rank = (id: string): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    const blockers = acyclicBlockersOf.get(id) ?? [];
    const depth = blockers.length > 0 ? 1 + Math.max(...blockers.map(rank)) : 0;
    ranks.set(id, depth);
    return depth;
  };

  for (const node of nodes) rank(node.id);
  return ranks;
};

// Within-layer order: map order where membership gives one — "first in map
// order wins" (ADR 0008) — then issue number ascending for the rest.
export const blockerOrders = (
  members: readonly string[],
  nodes: readonly BlockerLayoutNode[],
): Record<string, number> => {
  const orders: Record<string, number> = {};
  members.forEach((id, index) => {
    orders[id] = index;
  });
  const nonMembers = nodes
    .map((node) => node.id)
    .filter((id) => !(id in orders))
    .sort((left, right) => numberSuffix(left) - numberSuffix(right) || left.localeCompare(right));
  nonMembers.forEach((id, index) => {
    orders[id] = members.length + index;
  });
  return orders;
};

export type BlockerBox = { x: number; y: number; w: number; h: number; rank: number };

export type BlockerWarningNode = {
  blockerId: string;
  box: BlockerBox;
};

export type BlockerLayout = {
  positions: Record<string, BlockerBox>;
  warnings: BlockerWarningNode[];
  width: number;
  height: number;
};

// Geometry from the prototype: fixed-width depth columns (pitch 388), open
// boxes tall, closed boxes contracted to a single-line tier until the expand
// toggle opens them, each column stacked from the top and centered against
// the canvas — which grows when a wide layer needs the room.
const COLUMN_X = 36;
const COLUMN_PITCH = 388;
const MIN_HEIGHT = 716;
const TOP_MARGIN = 52;
const BOTTOM_MARGIN = 36;

const OPEN_BOX = { w: 230, h: 58, gap: 26 };
const CLOSED_BOX = { w: 168, h: 24, gap: 13 };
const CLOSED_EXPANDED_BOX = { w: 204, h: 48, gap: 13 };
const WARNING_BOX = { w: 216, h: 62 };
const WARNING_GAP = 78;

const boxFor = (node: BlockerLayoutNode, expandClosed: boolean) =>
  node.closed ? (expandClosed ? CLOSED_EXPANDED_BOX : CLOSED_BOX) : OPEN_BOX;

export const layoutBlockerGraph = ({
  nodes,
  edges,
  orders,
  expandClosed = false,
}: {
  nodes: readonly BlockerLayoutNode[];
  edges: readonly BlockerEdgePair[];
  orders: Record<string, number>;
  expandClosed?: boolean;
}): BlockerLayout => {
  const ranks = blockerRanks(nodes, edges);
  const known = new Set(nodes.map((node) => node.id));

  const columns = new Map<number, BlockerLayoutNode[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    if (!columns.has(rank)) columns.set(rank, []);
    columns.get(rank)!.push(node);
  }
  for (const column of columns.values()) {
    column.sort(
      (left, right) =>
        (orders[left.id] ?? Number.MAX_SAFE_INTEGER) -
        (orders[right.id] ?? Number.MAX_SAFE_INTEGER),
    );
  }

  const columnHeights = new Map<number, number>();
  for (const [rank, column] of columns) {
    const total = column.reduce((sum, node) => {
      const box = boxFor(node, expandClosed);
      return sum + box.h + box.gap;
    }, 0);
    columnHeights.set(
      rank,
      total === 0 ? 0 : total - boxFor(column[column.length - 1], expandClosed).gap,
    );
  }

  const tallest = Math.max(0, ...columnHeights.values());
  const height = Math.max(MIN_HEIGHT, TOP_MARGIN + tallest + BOTTOM_MARGIN);

  const positions: Record<string, BlockerBox> = {};
  for (const [rank, column] of columns) {
    const total = columnHeights.get(rank) ?? 0;
    let y = Math.max(TOP_MARGIN, (height - total) / 2);
    for (const node of column) {
      const box = boxFor(node, expandClosed);
      positions[node.id] = { x: COLUMN_X + rank * COLUMN_PITCH, y, w: box.w, h: box.h, rank };
      y += box.h + box.gap;
    }
  }

  // A dangling blocker gets a warning node in its would-be column — one left
  // of the ticket it gates — stacked below that column's own tier, so the
  // broken reference is visible instead of silently ungating work (ADR 0008).
  const warnings: BlockerWarningNode[] = [];
  const danglingSeen = new Set<string>();
  for (const edge of edges) {
    if (known.has(edge.blockerId) || !known.has(edge.blockedId)) continue;
    if (danglingSeen.has(edge.blockerId)) continue;
    danglingSeen.add(edge.blockerId);
    const column = Math.max(0, (ranks.get(edge.blockedId) ?? 0) - 1);
    const bottom = positions[[...(columns.get(column) ?? [])].at(-1)?.id ?? ""];
    const base = bottom ? bottom.y + bottom.h + 14 : TOP_MARGIN;
    const index = warnings.length;
    warnings.push({
      blockerId: edge.blockerId,
      box: {
        x: COLUMN_X + column * COLUMN_PITCH,
        y: Math.max(TOP_MARGIN, base) + index * WARNING_GAP,
        w: WARNING_BOX.w,
        h: WARNING_BOX.h,
        rank: column,
      },
    });
  }

  return {
    positions,
    warnings,
    width: COLUMN_X + Math.max(0, ...columns.keys()) * COLUMN_PITCH + OPEN_BOX.w + BOTTOM_MARGIN,
    height,
  };
};
