import type { OverviewData, WorkflowStatePayload } from "../types";

// One projection of the synced snapshot into the execution seam's read
// payload (ticket #59), shared by the seam endpoint and the route's bundled
// snapshot so the two never drift. Ticket #63 extends the payload with the
// decisions and artifacts its view groups.
export const workflowStateFrom = (snapshot: OverviewData): WorkflowStatePayload => ({
  workItems: snapshot.workItems,
  maps: snapshot.maps,
  blockerEdges: snapshot.blockerEdges,
  decisions: snapshot.decisions,
  artifacts: snapshot.artifacts,
  meta: { snapshot: snapshot.meta.snapshot, repo: snapshot.meta.repo },
  // GH-136: spread so an older snapshot without the field serializes without
  // the key instead of an undefined value.
  ...(snapshot.clientCoverage ? { clientCoverage: snapshot.clientCoverage } : {}),
});
