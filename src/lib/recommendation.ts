import type {
  TrackerMapRecord,
  WayfinderKind,
  WorkflowStatePayload,
  WorkItemRecord,
} from "../types";
import { clientKindFor, compareByClientTier } from "./client-priority";
import { deriveDisplayState } from "./display-state";
import { frontier, frontierItemFromWorkItem } from "./frontier";
import { inFlightBuckets } from "./in-flight";
import { byMapOrderThenNumber, mapOrderIndex } from "./map-order";
import { triageLanes } from "./triage";
import { workItemIdLabel } from "./work-item-id";

// The ordered priority table (spec #54, "Derivation", extended by ADR 0012):
// the recommendation engine is a pure function over the snapshot, layering
// readiness filters on the structural frontier and reading the buckets below
// in order — the global recommendation is the head of the first non-empty
// bucket. Client actions come first (client bugs, then client feedback,
// outrank all internal work); there is no to-spec row: grilling completion is
// not machine-detectable.
export const recommendationBuckets = [
  "client-action",
  "in-flight",
  "implementation-frontier",
  "map-frontier",
  "flow-advance",
  "triage-intake",
] as const;

export type RecommendationBucket = (typeof recommendationBuckets)[number];

// Copy is command-first — the action as skill command plus work item
// ("`/implement` #34") — with the reason as the secondary line naming its
// bucket. A recommendation without a command is informational: claimed
// work no control can resume until session spawning lands.
export type Recommendation = {
  bucket: RecommendationBucket;
  issueId: string;
  title: string;
  command: string | null;
  primary: string;
  reason: string;
};

// Buckets tiebreak by map order where membership gives one, otherwise issue
// number ascending — the shared comparator (map-order).
const compareInMapOrder = (maps: readonly TrackerMapRecord[]) =>
  byMapOrderThenNumber(mapOrderIndex(maps));

// The client tier (ADR 0012): the allowed actions a client ticket justifies —
// remediation for one that is grabbable, ticketed, and ready-for-agent, and
// triage for one still awaiting labels. Waiting client work (needs-info,
// ready-for-human, wontfix, deferred) is attention, not an allowed action, so
// it never appears here — the banner and the Client Tickets page carry it.
// Remediation outranks triage; inside each group, map order then number.
const clientActionBucket = (state: WorkflowStatePayload): Recommendation[] => {
  const compare = compareInMapOrder(state.maps);
  const remediation: Recommendation[] = [];
  for (const record of grabbableRecords(state)) {
    const kind = clientKindFor(record);
    if (kind === null) continue;
    const display = deriveDisplayState(record, false);
    if (
      display.phase !== "ticketed" ||
      display.triageState !== "ready-for-agent" ||
      display.deferred
    )
      continue;
    remediation.push({
      bucket: "client-action",
      issueId: record.id,
      title: record.title,
      command: "/implement",
      primary: `/implement ${workItemIdLabel(record.id)}`,
      reason:
        kind === "client-bug"
          ? "client bug — grabbable, ticketed, ready-for-agent; client bugs come before internal work"
          : "client feedback — grabbable, ticketed, ready-for-agent; client work comes before internal work",
    });
  }
  const { intake } = triageLanes(state.workItems, state.maps);
  const triageRows = intake
    .filter((record) => clientKindFor(record) !== null)
    .map((record) => {
      const kind = clientKindFor(record);
      return {
        bucket: "client-action" as const,
        issueId: record.id,
        title: record.title,
        command: "/triage",
        primary: `/triage ${workItemIdLabel(record.id)}`,
        reason:
          kind === "client-bug"
            ? "client bug awaiting triage — triage it before any internal work"
            : "client feedback awaiting triage — triage it before any internal work",
      };
    });
  return [
    ...remediation.sort((left, right) => compare(left.issueId, right.issueId)),
    ...triageRows.sort((left, right) => compare(left.issueId, right.issueId)),
  ];
};

const inFlightBucket = (state: WorkflowStatePayload): Recommendation[] => {
  const buckets = inFlightBuckets(state.workItems);
  const compare = compareInMapOrder(state.maps);
  const rows: { records: WorkItemRecord[]; command: string | null; reason: string }[] = [
    {
      records: buckets.reviewing,
      command: "/code-review",
      reason: "in-flight — reviewing outranks new starts",
    },
    {
      records: buckets.implementing,
      command: "/implement",
      reason: "in-flight — claimed and mid-implementation; resume before grabbing",
    },
    {
      records: buckets.notStarted,
      command: null,
      reason: "in-flight — claimed, not started; informational until session spawning lands",
    },
  ];
  const recommendations: Recommendation[] = [];
  for (const { records, command, reason } of rows) {
    for (const record of [...records].sort((left, right) => compare(left.id, right.id)))
      recommendations.push({
        bucket: "in-flight",
        issueId: record.id,
        title: record.title,
        command,
        primary: command
          ? `${command} ${workItemIdLabel(record.id)}`
          : `${workItemIdLabel(record.id)} claimed — not started`,
        reason,
      });
  }
  return recommendations;
};

// The structural frontier (open ∧ unassigned ∧ all blockers closed, computed
// never stored), resolved back to its work-item records in frontier order.
const grabbableRecords = (state: WorkflowStatePayload): WorkItemRecord[] => {
  const grabbable = frontier(
    state.workItems.map(frontierItemFromWorkItem),
    state.blockerEdges,
    state.maps,
  );
  return grabbable
    .map(({ id }) => state.workItems.find((item) => item.id === id))
    .filter((record): record is WorkItemRecord => record !== null);
};

const implementationFrontierBucket = (state: WorkflowStatePayload): Recommendation[] => {
  const mapIds = new Set(state.maps.map((map) => map.mapId));
  const recommendations: Recommendation[] = [];
  for (const record of grabbableRecords(state)) {
    if (mapIds.has(record.id)) continue;
    const display = deriveDisplayState(record, false);
    if (
      display.phase !== "ticketed" ||
      display.triageState !== "ready-for-agent" ||
      display.deferred
    )
      continue;
    recommendations.push({
      bucket: "implementation-frontier",
      issueId: record.id,
      title: record.title,
      command: "/implement",
      primary: `/implement ${workItemIdLabel(record.id)}`,
      reason: "implementation frontier — ticketed, ready-for-agent, every blocker closed",
    });
  }
  return recommendations;
};

// Readiness filters (spec #54, story 6): the recommendation never points at
// work waiting on someone else — needs-info, ready-for-human, deferred,
// wontfix, and shipped work are skipped in every bucket.
const waiting = (display: { triageState: string; deferred: boolean; phase: string | null }) =>
  display.deferred ||
  display.phase === "shipped" ||
  ["needs-info", "ready-for-human", "wontfix"].includes(display.triageState);

// The map frontier: grabbable decision tickets, worked per kind in map
// order — first in map order wins. The kind names the working skill
// (/wayfinder "Ticket Types"); a task ticket's doing-side work has no
// dedicated skill, so wayfinder drives it.
type DecisionTicketKind = Exclude<WayfinderKind, "map">;

const KIND_COMMAND: Record<DecisionTicketKind, string> = {
  research: "/research",
  prototype: "/prototype",
  grilling: "/grilling",
  task: "/wayfinder",
};

const isDecisionTicket = (
  record: WorkItemRecord,
): record is WorkItemRecord & { kind: DecisionTicketKind } =>
  record.kind !== null && record.kind !== "map";

const mapFrontierBucket = (state: WorkflowStatePayload): Recommendation[] => {
  const recommendations: Recommendation[] = [];
  for (const record of grabbableRecords(state)) {
    if (!isDecisionTicket(record)) continue;
    const display = deriveDisplayState(record, false);
    if (waiting(display)) continue;
    const command = KIND_COMMAND[record.kind];
    recommendations.push({
      bucket: "map-frontier",
      issueId: record.id,
      title: record.title,
      command,
      primary: command
        ? `${command} ${workItemIdLabel(record.id)}`
        : `${workItemIdLabel(record.id)} claimed — not started`,
      reason: `map frontier — grabbable ${record.kind} ticket, first in map order`,
    });
  }
  return recommendations;
};

// Flow advance: `/to-tickets` on maps sitting at specced. Maps carry
// phase like any issue (ADR 0007 — to-spec labels the map), so a specced
// map is the flow-advance signal. There is no to-spec row: grilling
// completion is not machine-detectable.
const flowAdvanceBucket = (state: WorkflowStatePayload): Recommendation[] => {
  const compare = compareInMapOrder(state.maps);
  const recommendations: Recommendation[] = [];
  const specced = state.maps
    .map((map) => state.workItems.find((item) => item.id === map.mapId))
    .filter((record): record is WorkItemRecord => record !== undefined)
    .filter((record) => record.phase === "specced")
    .sort((left, right) => compare(left.id, right.id));
  for (const record of specced) {
    const display = deriveDisplayState(record, false);
    if (waiting(display)) continue;
    recommendations.push({
      bucket: "flow-advance",
      issueId: record.id,
      title: record.title,
      command: "/to-tickets",
      primary: `/to-tickets ${workItemIdLabel(record.id)}`,
      reason: "flow advance — the map sits at specced, ready for tickets",
    });
  }
  return recommendations;
};

// Triage intake: the triage skill's surface, one membership definition
// shared with the triage view — unlabeled ∪ needs-triage with map children
// excluded. The lanes' first-match partition also keeps wontfix,
// needs-info, ready-for-human, and deferred work off intake, so the
// readiness filters are inherited rather than restated here.
const triageIntakeBucket = (state: WorkflowStatePayload): Recommendation[] => {
  const { intake } = triageLanes(state.workItems, state.maps);
  return intake.map((record) => ({
    bucket: "triage-intake" as const,
    issueId: record.id,
    title: record.title,
    command: "/triage",
    primary: `/triage ${workItemIdLabel(record.id)}`,
    reason: "triage intake — fresh work awaiting triage",
  }));
};

const BUCKETS: readonly ((state: WorkflowStatePayload) => Recommendation[])[] = [
  clientActionBucket,
  inFlightBucket,
  implementationFrontierBucket,
  mapFrontierBucket,
  flowAdvanceBucket,
  triageIntakeBucket,
];

export const recommendNextAction = (state: WorkflowStatePayload): Recommendation | null => {
  for (const bucket of BUCKETS) {
    const head = bucket(state)?.[0];
    if (head) return head;
  }
  return null;
};

// The repo-wide frontier strip: each map's grabbable head in map order, plus
// the unmapped grabbable issues — client tickets head the list (tier order,
// ADR 0012), the rest ascending issue number, deterministically. Both halves
// are the structural frontier (open ∧ unassigned ∧ all blockers closed,
// unknown references fail closed).
export type FrontierStripMap = {
  map: TrackerMapRecord;
  head: WorkItemRecord | null;
};

export type FrontierStrip = {
  maps: readonly FrontierStripMap[];
  unmapped: readonly WorkItemRecord[];
};

export const frontierStrip = (state: WorkflowStatePayload): FrontierStrip => {
  const grabbableIds = new Set(grabbableRecords(state).map((record) => record.id));
  const recordFor = (id: string) => state.workItems.find((item) => item.id === id) ?? null;
  const mapped = new Set(state.maps.flatMap((map) => [...map.ticketIds]));
  const mapIds = new Set(state.maps.map((map) => map.mapId));
  return {
    maps: state.maps.map((map) => {
      const headId = map.ticketIds.find((id) => grabbableIds.has(id));
      return { map, head: headId ? recordFor(headId) : null };
    }),
    unmapped: grabbableRecords(state)
      .filter((record) => !mapped.has(record.id) && !mapIds.has(record.id))
      .sort(compareByClientTier),
  };
};
