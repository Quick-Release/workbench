import type { OverviewData, WorkflowStatePayload } from "../types";

// One projection of the synced snapshot into the execution seam's read
// payload (ticket #59), shared by the seam endpoint and the route's bundled
// snapshot so the two never drift. Later tickets extend the payload with
// decisions and artifacts.
export const workflowStateFrom = (snapshot: OverviewData): WorkflowStatePayload => ({
  workItems: snapshot.workItems,
  maps: snapshot.maps,
  blockerEdges: snapshot.blockerEdges,
  meta: { snapshot: snapshot.meta.snapshot, repo: snapshot.meta.repo },
});
