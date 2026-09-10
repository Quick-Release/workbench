import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { IssuePanelHost } from "../components/IssuePanelHost";
import { TriagePage, type TriageLens } from "../components/TriagePage";
import { setWorkflowState, useWorkflowMode, useWorkflowState } from "../hooks/use-workflow-state";
import { issueParamFromSearch } from "../lib/issue-param";
import { workItemIdNumberText } from "../lib/work-item-id";
import { parseTriageMoveResult } from "../schema";
import type { TriageState } from "../types";

type TriageSearch = { lens?: TriageLens; issue?: string };

export const Route = createFileRoute("/triage")({
  validateSearch: (search: Record<string, unknown>): TriageSearch => ({
    lens: search.lens === "wontfix" ? "wontfix" : undefined,
    issue: issueParamFromSearch(search),
  }),
  component: TriageRoute,
});

// Each action posts exactly its seam schema's fields — the shared wire
// grammar (`issue-actions`) picks the route and the fields, so the panel
// behaves identically on every view.
function TriageRoute() {
  // The shared workflow atom (see use-workflow-state): the bundled snapshot
  // paints the first render, the live read replaces it, and a move pushes
  // its re-read result here — the same state every other view sees.
  const state = useWorkflowState();
  const mode = useWorkflowMode();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lens = Route.useSearch({ select: (search) => search.lens ?? "none" });
  const issueParam = Route.useSearch({ select: (search) => search.issue });
  const navigate = Route.useNavigate();

  const setIssueParam = (issue: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, issue }) });

  const move = async (issueId: string, triageState: TriageState) => {
    setPendingId(issueId);
    setMessage(null);
    try {
      const response = await fetch("/api/workflow/triage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issueId,
          triageState,
          ...(triageState === "wontfix" ? { confirm: true } : {}),
        }),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setMessage(failure ?? `The move was rejected (${response.status}).`);
        return;
      }
      // The seam answers with the re-read state, so the row moves on the
      // next render without a manual reload.
      const result = parseTriageMoveResult(raw);
      setWorkflowState(result.state);
      setMessage(result.message);
    } catch {
      setMessage("The move did not go through — the dev server API is not reachable.");
    } finally {
      setPendingId(null);
    }
  };

  return (
    <>
      <TriagePage
        workItems={state.workItems}
        maps={state.maps}
        blockerEdges={state.blockerEdges}
        mode={mode}
        lens={lens}
        onLensChange={(next) =>
          navigate({
            search: (prev) => ({ ...prev, lens: next === "wontfix" ? "wontfix" : undefined }),
          })
        }
        onMove={(issueId, triageState) => void move(issueId, triageState)}
        onOpenIssue={(issueId) => setIssueParam(workItemIdNumberText(issueId))}
        onNewIssue={() => setIssueParam("new")}
        pendingId={pendingId}
        message={message}
      />
      <IssuePanelHost
        issueParam={issueParam}
        onParamChange={setIssueParam}
        onCreated={setIssueParam}
      />
    </>
  );
}
