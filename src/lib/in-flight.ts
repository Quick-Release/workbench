import type { WorkItemRecord } from "../types";
import { deriveDisplayState } from "./display-state";

// ADR 0010's in-flight bucket (ticket #62): the assigned work a Developer
// resumes before grabbing anything new, in priority order — reviewing, then
// implementing, then claimed-but-not-started. Membership derives from
// display state alone; the view over it is informational only.
export type InFlightBuckets = {
  reviewing: WorkItemRecord[];
  implementing: WorkItemRecord[];
  notStarted: WorkItemRecord[];
};

const byIssueNumber = (left: WorkItemRecord, right: WorkItemRecord) =>
  Number(left.id.slice(3)) - Number(right.id.slice(3));

// The excluded states (ticket #62): work waiting on someone else or already
// done never poses as in flight — needs-info and ready-for-human belong to
// the triage Waiting lanes, wontfix to the refusal lens, deferred to parked,
// and shipped is terminal.
const EXCLUDED_TRIAGE: ReadonlySet<WorkItemRecord["triageState"]> = new Set([
  "needs-info",
  "ready-for-human",
  "wontfix",
]);

export const inFlightBuckets = (workItems: readonly WorkItemRecord[]): InFlightBuckets => {
  const buckets: InFlightBuckets = { reviewing: [], implementing: [], notStarted: [] };
  for (const record of workItems) {
    const display = deriveDisplayState(record, false);
    if (display.state !== "open" || !display.claimed) continue;
    if (EXCLUDED_TRIAGE.has(display.triageState) || display.deferred) continue;
    if (display.phase === "shipped") continue;
    if (display.phase === "reviewing") buckets.reviewing.push(record);
    else if (display.phase === "implementing") buckets.implementing.push(record);
    else buckets.notStarted.push(record);
  }
  buckets.reviewing.sort(byIssueNumber);
  buckets.implementing.sort(byIssueNumber);
  buckets.notStarted.sort(byIssueNumber);
  return buckets;
};
