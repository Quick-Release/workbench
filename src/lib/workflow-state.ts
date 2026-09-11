import type { OverviewData, WorkflowStatePayload } from "../types";

// One projection of the synced snapshot into the execution seam's read
// payload (ticket #59), shared by the seam endpoint and the route's bundled
// snapshot so the two never drift. Ticket #63 extends the payload with the
// decisions and artifacts its view groups. GH-145 adds the freshness stamp
// (when the snapshot carries one) and — live reads only — the sync warnings
// channel; both spread conditionally so an older snapshot serializes without
// the key instead of an undefined value.
export const workflowStateFrom = (
  snapshot: OverviewData,
  warnings?: readonly string[],
): WorkflowStatePayload => ({
  workItems: snapshot.workItems,
  maps: snapshot.maps,
  blockerEdges: snapshot.blockerEdges,
  decisions: snapshot.decisions,
  artifacts: snapshot.artifacts,
  meta: {
    snapshot: snapshot.meta.snapshot,
    repo: snapshot.meta.repo,
    // GH-145: rides only when the snapshot carries it.
    ...(snapshot.meta.syncedAt ? { syncedAt: snapshot.meta.syncedAt } : {}),
  },
  // GH-145: the sync warnings channel, live reads only.
  ...(warnings && warnings.length > 0 ? { warnings } : {}),
  // Ticket #146: the board's shipped page and parsed placement table ride
  // only when the snapshot carries them, same as the freshness stamp.
  ...(snapshot.recentlyShipped ? { recentlyShipped: snapshot.recentlyShipped } : {}),
  ...(snapshot.decisionPlacement ? { decisionPlacement: snapshot.decisionPlacement } : {}),
  // GH-136: spread so an older snapshot without the field serializes without
  // the key instead of an undefined value.
  ...(snapshot.clientCoverage ? { clientCoverage: snapshot.clientCoverage } : {}),
});
