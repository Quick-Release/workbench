import type { TriageState, TrackerMapRecord, WorkItemRecord } from "../types";
import { byIssueNumber, workItemIdNumberText } from "./work-item-id";

// The triage view's lanes (ticket #59): an Intake lane — the triage skill's
// surface of unlabeled ∪ needs-triage issues with map children excluded — and
// a Waiting lane grouped by whose move it is. Wontfix items render only
// behind the deliberate lens, so `refused` is data the view gates.
export type TriageLanes = {
  intake: WorkItemRecord[];
  waiting: {
    reporter: WorkItemRecord[];
    human: WorkItemRecord[];
    parked: WorkItemRecord[];
  };
  refused: WorkItemRecord[];
};

export const isMapChild = (record: WorkItemRecord, maps: readonly TrackerMapRecord[]) =>
  maps.some((map) => map.ticketIds.includes(record.id));

// Partition rule, first match wins: refusal, then the Waiting groups in
// whose-move order (reporter, human, parked), then Intake — unlabeled ∪
// needs-triage outside the maps. Closed items and items already triaged
// ready-for-agent belong to no lane here — the former are history, the
// latter are the frontier, not triage work.
export const triageLanes = (
  workItems: readonly WorkItemRecord[],
  maps: readonly TrackerMapRecord[],
): TriageLanes => {
  const lanes: TriageLanes = {
    intake: [],
    waiting: { reporter: [], human: [], parked: [] },
    refused: [],
  };
  const open = workItems.filter((item) => item.state === "open");
  for (const item of open) {
    const inIntake = item.triageState === "unlabeled" || item.triageState === "needs-triage";
    if (item.triageState === "wontfix") lanes.refused.push(item);
    else if (item.triageState === "needs-info") lanes.waiting.reporter.push(item);
    else if (item.triageState === "ready-for-human") lanes.waiting.human.push(item);
    else if (item.deferred) lanes.waiting.parked.push(item);
    else if (inIntake && !isMapChild(item, maps)) lanes.intake.push(item);
  }
  lanes.intake.sort(byIssueNumber);
  lanes.waiting.reporter.sort(byIssueNumber);
  lanes.waiting.human.sort(byIssueNumber);
  lanes.waiting.parked.sort(byIssueNumber);
  lanes.refused.sort(byIssueNumber);
  return lanes;
};

// The row's move menu: every triage state but the one already worn, with
// wontfix reachable only behind the deliberate lens (story 18).
export const targetStatesFor = (current: TriageState, refusedLens: boolean): TriageState[] => {
  const ordered: TriageState[] = [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "unlabeled",
    "wontfix",
  ];
  return ordered.filter((state) => state !== current && (refusedLens || state !== "wontfix"));
};

// The state a row settles into when the seam is unreachable: the copyable gh
// command replaces the move menu (static builds degrade actions to
// copy-the-command). Parked work re-enters evaluation; wontfix is terminal,
// so a refusal gets no command.
const SETTLE_TARGET: Record<TriageState, TriageState | null> = {
  unlabeled: "ready-for-agent",
  "needs-triage": "ready-for-agent",
  "needs-info": "ready-for-agent",
  "ready-for-human": "ready-for-agent",
  wontfix: null,
  "ready-for-agent": null,
};

export const staticMoveCommand = (record: WorkItemRecord): string => {
  const target = record.deferred ? "needs-triage" : SETTLE_TARGET[record.triageState];
  if (!target) return "";
  const args = ["gh issue edit", workItemIdNumberText(record.id), "--add-label", target];
  if (record.deferred) args.push("--remove-label", "deferred");
  if (record.triageState !== "unlabeled" && record.triageState !== target)
    args.push("--remove-label", record.triageState);
  return args.join(" ");
};
