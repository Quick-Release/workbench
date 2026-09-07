import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { IssueDetailPanel } from "../components/IssueDetailPanel";
import { OverviewPage } from "../components/OverviewPage";
import { overviewData } from "../data";
import { useIssueActionRunner } from "../hooks/use-issue-actions";
import { useWorkflowMode, useWorkflowState, setWorkflowState } from "../hooks/use-workflow-state";
import { issueParamFromSearch, panelIdFor } from "../lib/issue-param";
import { parseSyncTriggerResult } from "../schema";

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
  const [syncPending, setSyncPending] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncWarnings, setSyncWarnings] = useState<readonly string[]>([]);
  const {
    pending: panelPending,
    message: panelMessage,
    run: runIssueAction,
  } = useIssueActionRunner();
  const issueParam = Route.useSearch({ select: (s) => s.issue });
  const panelIssueId = panelIdFor(issueParam);

  const setIssueParam = (issue: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, issue }) });

  const sync = async () => {
    setSyncPending(true);
    setSyncMessage(null);
    setSyncWarnings([]);
    try {
      const response = await fetch("/api/workflow/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setSyncMessage(failure ?? `The sync was rejected (${response.status}).`);
        return;
      }
      const result = parseSyncTriggerResult(raw);
      setWorkflowState(result.state);
      setSyncMessage(result.message);
      setSyncWarnings(result.warnings);
    } catch {
      setSyncMessage("The sync did not go through — the dev server API is not reachable.");
    } finally {
      setSyncPending(false);
    }
  };

  return (
    <>
      <OverviewPage
        data={overviewData}
        state={state}
        mode={mode}
        onOpenIssue={(issueId) => setIssueParam(issueId.slice(3))}
        onSync={() => void sync()}
        syncPending={syncPending}
        syncMessage={syncMessage}
        syncWarnings={syncWarnings}
      />
      <IssueDetailPanel
        issueId={panelIssueId}
        state={state}
        mode={mode}
        pending={panelPending}
        message={panelMessage}
        onOpenChange={(open) => {
          if (!open) setIssueParam(undefined);
        }}
        onAction={(action) =>
          void runIssueAction(action, undefined, (issueId) => setIssueParam(issueId))
        }
      />
    </>
  );
}
