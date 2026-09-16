// Types for client-priority.mjs (GH-195): the implementation is plain ESM so
// the installed CLI's raw-Node sync can import it from node_modules.
import type { BlockerEdgeRecord, ClientTicketKind, WorkItemRecord } from "../types";

// The canonical client-label vocabulary; src/types.ts re-exports this const
// and derives ClientTicketKind from it, so the vocabularies cannot drift.
export declare const clientTicketKinds: readonly ["client-bug", "client-feedback"];
export declare const clientBugKind: "client-bug";
export declare const clientFeedbackKind: "client-feedback";

export declare const classifyClientTicket: (
  labels: readonly string[] | undefined,
) => ClientTicketKind | null;

export declare const clientKindFor: (record: {
  labels?: readonly string[];
  category: WorkItemRecord["category"];
}) => ClientTicketKind | null;

export declare const clientTierFor: (record: {
  labels?: readonly string[];
  category: WorkItemRecord["category"];
}) => 0 | 1 | 2;

export declare const compareByClientTier: (left: WorkItemRecord, right: WorkItemRecord) => number;

export type ClientAttention = {
  bugs: readonly WorkItemRecord[];
  feedback: readonly WorkItemRecord[];
};

export declare const clientAttention: (workItems: readonly WorkItemRecord[]) => ClientAttention;

export type ClientGateBlockingBug = {
  id: string;
  title: string;
  url: string;
};

export declare const openClientBugs: (
  workItems: readonly WorkItemRecord[],
) => ClientGateBlockingBug[];

export declare const clientWaitingReason: (
  record: WorkItemRecord,
  workItems: readonly WorkItemRecord[],
  blockerEdges: readonly BlockerEdgeRecord[],
) => string | null;

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

export declare const evaluateClientGate: (input: ClientGateInput) => ClientGateVerdict;
