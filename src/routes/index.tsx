import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { IssuePanelHost } from "../components/IssuePanelHost";
import { OverviewPage } from "../components/OverviewPage";
import { overviewData } from "../data";
import { useWorkflowMode, useWorkflowState } from "../hooks/use-workflow-state";
import { useSyncTrigger } from "../hooks/use-sync-trigger";
import { issueParamFromSearch } from "../lib/issue-param";
import { workItemIdNumberText } from "../lib/work-item-id";

const searchSchema = z.object({
  // The detail panel's param (ticket #60): `?issue=NN` / `?issue=new`,
  // validated by the shared grammar the other views use.
  issue: z.string().catch(""),
});

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...searchSchema.parse(search),
    issue: issueParamFromSearch(search),
  }),
  component: WorkbenchRoute,
});

function WorkbenchRoute() {
  const navigate = useNavigate({ from: Route.fullPath });

  // The shared workflow atom (see use-workflow-state): the header chip and
  // this page read one state, so syncs and panel actions update both.
  const state = useWorkflowState();
  const mode = useWorkflowMode();
  // GH-145: the header's trigger and this page's sync section share one
  // runner, so a sync from either refreshes both.
  const {
    pending: syncPending,
    message: syncMessage,
    warnings: syncWarnings,
    sync,
  } = useSyncTrigger();
  const issueParam = Route.useSearch({ select: (s) => s.issue });

  const setIssueParam = (issue: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, issue }) });

  return (
    <>
      <OverviewPage
        data={overviewData}
        state={state}
        mode={mode}
        onOpenIssue={(issueId) => setIssueParam(workItemIdNumberText(issueId))}
        onSync={() => void sync()}
        syncPending={syncPending}
        syncMessage={syncMessage}
        syncWarnings={syncWarnings}
      />
      <IssuePanelHost
        issueParam={issueParam}
        onParamChange={setIssueParam}
        onCreated={setIssueParam}
      />
    </>
  );
}
