import type {
  BlockerEdgeRecord,
  DecisionPlacementRow,
  TrackerMapRecord,
  WorkItemRecord,
} from "../types";
import { phaseMoveTargets } from "../types";
import { deriveDisplayState, type DisplayCaveat } from "./display-state";
import { frontier, frontierItemFromWorkItem, indexWorkItems, openBlockers } from "./frontier";
import { phaseClockLine, type PhaseClockLine } from "./phase-clock";
import { byIssueNumber } from "./work-item-id";

// The flow board's derivation (ticket #146, the read-only board): pure over
// the workflow payload — placement, chips, caveats, and warnings — so the
// rendering consumes the results verbatim. Columns are pre-flow plus the
// seven canonical phases in flow order; placement is derived, never stored.

// Pre-flow is the board's fallback column, never a phase: a work item with
// no `workflow:` label has not been touched by a flow skill yet (ADR 0007).
// The columns are the phase-move targets' vocabulary (ticket #148): a move
// speaks the columns it lands between.
export const boardColumns = phaseMoveTargets;

export type BoardColumn = (typeof boardColumns)[number];

// The canonical decision-ticket placement (docs/agents/workflow-labels.md,
// "Board placement"), mirrored as the fallback for snapshots that predate
// the table riding the payload. Research shares grilling's column; task is
// doing-side work that reads as ticketed.
export const DEFAULT_DECISION_PLACEMENT: readonly DecisionPlacementRow[] = [
  { kind: "grilling", openColumn: "grilling", closedColumn: "shipped" },
  { kind: "research", openColumn: "grilling", closedColumn: "shipped" },
  { kind: "prototype", openColumn: "prototyping", closedColumn: "shipped" },
  { kind: "task", openColumn: "ticketed", closedColumn: "shipped" },
];

export type BoardCardChips = {
  blocked: boolean;
  grabbable: boolean;
  parked: boolean;
  claimed: boolean;
  decided: boolean;
  ruledOut: boolean;
};

export type BoardCard = {
  record: WorkItemRecord;
  column: BoardColumn;
  chips: BoardCardChips;
  caveats: DisplayCaveat[];
  // GH-149: the card's clock line — time in phase where the event-derived
  // clock exists, last-touched where it doesn't, null for decision tickets
  // and pre-flow items.
  clock: PhaseClockLine | null;
  // The sync warnings addressed to this card (issue-id-prefixed lines of the
  // payload's warnings channel — the double-label resolutions live here),
  // never re-derived from labels.
  warnings: readonly string[];
};

export type BoardColumnView = {
  key: BoardColumn;
  cards: BoardCard[];
};

export type BoardInput = {
  workItems: readonly WorkItemRecord[];
  // The shipped column's bounded page (ticket #146): closed issues wearing
  // `workflow:shipped`, collected at sync — absent in older snapshots.
  recentlyShipped?: readonly WorkItemRecord[];
  blockerEdges: readonly BlockerEdgeRecord[];
  maps: readonly TrackerMapRecord[];
  decisionPlacement?: readonly DecisionPlacementRow[];
  warnings?: readonly string[];
  // GH-149: the instant the clock lines are computed against. Tests pin it;
  // live callers pass the read time.
  now?: number;
  // The deferred lens: parked work renders in place only behind it, never as
  // a ninth column.
  deferredLens?: boolean;
};

const isDecisionTicket = (record: WorkItemRecord) => record.kind !== null && record.kind !== "map";

// One card's column: decision tickets place by the parsed table (open vs
// closed; claiming never moves them), everything else — maps included — by
// its resolved phase, pre-flow when no flow skill has touched it. A kind
// with no table row falls back to pre-flow rather than a guessed column.
export const boardColumnFor = (
  record: WorkItemRecord,
  placement: readonly DecisionPlacementRow[] = DEFAULT_DECISION_PLACEMENT,
): BoardColumn => {
  if (isDecisionTicket(record)) {
    const row = placement.find((entry) => entry.kind === record.kind);
    if (!row) return "pre-flow";
    return record.state === "open" ? row.openColumn : row.closedColumn;
  }
  return record.phase ?? "pre-flow";
};

// The board's columns with their cards. Work items and the shipped page
// merge into one pool before placement (a record held by both counts once,
// the work-item copy wins), so the closed shipped work the open sweep never
// holds still lands in shipped — and satisfies other cards' gates.
export const board = (input: BoardInput): BoardColumnView[] => {
  const placement = input.decisionPlacement ?? DEFAULT_DECISION_PLACEMENT;

  const pool: WorkItemRecord[] = [];
  const seen = new Set<string>();
  for (const record of [...input.workItems, ...(input.recentlyShipped ?? [])]) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    pool.push(record);
  }

  const byId = indexWorkItems(pool);
  const grabbableIds = new Set(
    frontier(pool.map(frontierItemFromWorkItem), input.blockerEdges, input.maps).map(
      (item) => item.id,
    ),
  );

  const cards = pool
    .filter((record) => input.deferredLens || !record.deferred)
    .map<BoardCard>((record) => {
      // Fail-closed like the frontier: a dangling blocker reference counts
      // as an open gate, never as silence.
      const { open, dangling } = openBlockers(record.id, input.blockerEdges, byId);
      const blocked = open.length > 0 || dangling.length > 0;
      const { caveats } = deriveDisplayState(record, blocked);
      return {
        record,
        column: boardColumnFor(record, placement),
        clock: phaseClockLine(record, input.now ?? Date.now()),
        chips: {
          blocked,
          grabbable: grabbableIds.has(record.id),
          parked: record.deferred,
          claimed: record.assignees.length > 0,
          decided:
            isDecisionTicket(record) &&
            record.state === "closed" &&
            record.stateReason === "completed",
          ruledOut:
            isDecisionTicket(record) &&
            record.state === "closed" &&
            record.stateReason === "not_planned",
        },
        caveats,
        warnings: (input.warnings ?? []).filter((warning) => warning.startsWith(`${record.id}: `)),
      };
    })
    .sort((left, right) => byIssueNumber(left.record, right.record));

  return boardColumns.map((key) => ({
    key,
    cards: cards.filter((card) => card.column === key),
  }));
};
