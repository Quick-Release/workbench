// The value imports keep the explicit extensions so the tracker scripts and
// the seam — plain Node ESM importing src TS directly — can share this
// module; the type imports erase.
import {
  clientTicketKinds,
  type BlockerEdgeRecord,
  type ClientTicketKind,
  type WorkItemRecord,
} from "../types.ts";
import { workItemIdNumber } from "./work-item-id.ts";

// The canonical label names, exported for readers that walk GitHub by label
// (the tracker's client discovery) — always from here, never re-declared.
export const [clientBugKind, clientFeedbackKind] = clientTicketKinds;

// GH-136: the client-first work policy's pure half — one module the tracker,
// the seam, and the UI all read, so classification, ordering, and the
// feature-start gate can never drift apart. Client origin is *declared* by
// label, never inferred from author identity, title wording, or an LLM.
//
// The policy keeps two results apart: client *attention* is every open client
// ticket regardless of executability; *allowed actions* pass only what the
// ticket's triage state, blocker edges, and ownership justify. The bug gate
// is the enforced half of the second result (ADR 0012).

// Exact-name match after light normalization — never a substring:
// "client-bugs", "verify-client-bug", and "client bug triage" do not
// classify. Whitespace/underscore/case variants of the canonical names do.
const normalizeLabelName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

export const classifyClientTicket = (
  labels: readonly string[] | undefined,
): ClientTicketKind | null => {
  if (!labels) return null;
  const normalized = new Set(labels.map(normalizeLabelName));
  if (normalized.has(clientBugKind)) return "client-bug";
  if (normalized.has(clientFeedbackKind)) return "client-feedback";
  return null;
};

// The effective kind. A `client-feedback` issue categorized `bug` receives
// bug-tier treatment: inconsistent tagging must not open a gate bypass by
// dressing a client defect up as feedback (or vice versa).
export const clientKindFor = (record: {
  labels?: readonly string[];
  category: WorkItemRecord["category"];
}): ClientTicketKind | null => {
  const kind = classifyClientTicket(record.labels);
  if (kind === "client-feedback" && record.category === "bug") return "client-bug";
  return kind;
};

// 0 = client bug, 1 = client feedback, 2 = internal work.
export const clientTierFor = (record: {
  labels?: readonly string[];
  category: WorkItemRecord["category"];
}): 0 | 1 | 2 => {
  const kind = clientKindFor(record);
  if (kind === "client-bug") return 0;
  return kind === "client-feedback" ? 1 : 2;
};

const issueNumberOf = (record: { id: string }): number => workItemIdNumber(record.id);

// Tier order first, deterministic issue-number fallback; a stable sort in the
// caller keeps the existing readiness/map-order rules inside each tier.
export const compareByClientTier = (left: WorkItemRecord, right: WorkItemRecord): number => {
  const tier = clientTierFor(left) - clientTierFor(right);
  if (tier !== 0) return tier;
  return issueNumberOf(left) - issueNumberOf(right);
};

export type ClientAttention = {
  bugs: readonly WorkItemRecord[];
  feedback: readonly WorkItemRecord[];
};

// Client attention: every open client ticket, whether or not anything can be
// done about it right now. Deferred, untriaged, wontfix, and waiting tickets
// stay here — attention is not executability.
export const clientAttention = (workItems: readonly WorkItemRecord[]): ClientAttention => {
  const open = workItems.filter((record) => record.state === "open");
  return {
    bugs: open.filter((record) => clientKindFor(record) === "client-bug").sort(compareByClientTier),
    feedback: open
      .filter((record) => clientKindFor(record) === "client-feedback")
      .sort(compareByClientTier),
  };
};

export type ClientGateBlockingBug = {
  id: string;
  title: string;
  url: string;
};

export const openClientBugs = (workItems: readonly WorkItemRecord[]): ClientGateBlockingBug[] =>
  workItems
    .filter((record) => record.state === "open" && clientKindFor(record) === "client-bug")
    .map((record) => ({ id: record.id, title: record.title, url: record.url }))
    .sort((left, right) => issueNumberOf(left) - issueNumberOf(right));

// The row's waiting/blocked explanation, computed from blocker edges and the
// record's own state — never a stored status. Blocked outranks parked, which
// outranks the explicit waiting states; an actionable ticket explains nothing
// and renders no excuse (GH-136).
export const clientWaitingReason = (
  record: WorkItemRecord,
  workItems: readonly WorkItemRecord[],
  blockerEdges: readonly BlockerEdgeRecord[],
): string | null => {
  const stateById = new Map(workItems.map((item) => [item.id, item]));
  const openBlockers = blockerEdges
    .filter((edge) => edge.blockedId === record.id)
    .map((edge) => edge.blockerId)
    .filter((id) => stateById.get(id)?.state === "open")
    .sort((left, right) => issueNumberOf({ id: left }) - issueNumberOf({ id: right }));
  if (openBlockers.length > 0) return `blocked by ${openBlockers.join(", ")}`;
  if (record.deferred) return "parked (deferred)";
  switch (record.triageState) {
    case "needs-info":
      return "waiting on information";
    case "ready-for-human":
      return "waiting on a human";
    case "wontfix":
      return "refused (wontfix)";
    case "needs-triage":
    case "unlabeled":
      return "awaiting triage";
    default:
      return null;
  }
};

export type ClientGateDenialReason =
  | "target_not_open"
  | "client_priority_unverified"
  | "client_bugs_open";

export type ClientGateTarget = {
  state: WorkItemRecord["state"];
  labels?: readonly string[];
  category: WorkItemRecord["category"];
  kind: WorkItemRecord["kind"];
};

export type ClientGateInput = {
  // The resolved target — null when the issue cannot be resolved at all.
  target: ClientGateTarget | null;
  // False when the last client-ticket pass was capped, failed, or is missing:
  // an incomplete snapshot never grants a fresh all-clear.
  coverageComplete: boolean;
  openClientBugs?: readonly ClientGateBlockingBug[];
  // Ids of open client bugs this target is a *validated* blocker edge of —
  // the caller validates the edges; readiness checks stay the caller's too.
  prerequisiteOfOpenClientBugs?: readonly string[];
};

export type ClientGateVerdict = {
  allowed: boolean;
  reason: ClientGateDenialReason | null;
  blockingBugs: readonly ClientGateBlockingBug[];
  explanation: string;
};

const allowed = (blockingBugs: readonly ClientGateBlockingBug[]): ClientGateVerdict => ({
  allowed: true,
  reason: null,
  blockingBugs,
  explanation: "",
});

// The bug gate (ADR 0012): while any open client bug exists, unrelated
// feature implementation cannot start. Fail-closed like the frontier (ADR
// 0008) — a target that cannot be affirmatively classified never silently
// passes, and unverified coverage never reads as "no client bugs".
export const evaluateClientGate = ({
  target,
  coverageComplete,
  openClientBugs: bugs = [],
  prerequisiteOfOpenClientBugs = [],
}: ClientGateInput): ClientGateVerdict => {
  const names = (list: readonly ClientGateBlockingBug[]) =>
    list.map((bug) => `${bug.id} "${bug.title}"`).join(", ");
  if (!target || target.state !== "open")
    return {
      allowed: false,
      reason: "target_not_open",
      blockingBugs: bugs,
      explanation: "Target issue is not open; there is nothing to start.",
    };
  // Wayfinder decision tickets resolve into decisions, not build slices —
  // planning stays available under the gate.
  if (target.kind !== null) return allowed(bugs);
  // Remediation of an open client ticket is always the point.
  if (classifyClientTicket(target.labels) !== null) return allowed(bugs);
  // A validated prerequisite of an open client bug ("unblocks client bug #N")
  // is justified work; dependency and readiness checks stay with the caller.
  if (prerequisiteOfOpenClientBugs.length > 0) return allowed(bugs);
  // An internal bug fix is not feature implementation — allow it even when
  // client coverage is unverified: the gate pauses features, not remediation.
  if (target.category === "bug" && classifyClientTicket(target.labels) === null)
    return allowed(bugs);
  if (!coverageComplete)
    return {
      allowed: false,
      reason: "client_priority_unverified",
      blockingBugs: bugs,
      explanation:
        "Client-ticket coverage is incomplete or stale, so the gate cannot verify there is no open client bug; re-sync and retry.",
    };
  if (bugs.length > 0)
    return {
      allowed: false,
      reason: "client_bugs_open",
      blockingBugs: bugs,
      explanation: `${bugs.length === 1 ? "1 open client bug" : `${bugs.length} open client bugs`} — ${names(bugs)}. New feature starts are paused until ${bugs.length === 1 ? "it closes" : "they close"}.`,
    };
  return allowed(bugs);
};
