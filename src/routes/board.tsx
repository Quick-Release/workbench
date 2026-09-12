import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/BoardPage";
import type { IssuePanelAction } from "../components/IssueDetailPanel";
import { IssuePanelHost } from "../components/IssuePanelHost";
import { setWorkflowState, useWorkflowMode, useWorkflowState } from "../hooks/use-workflow-state";
import { board } from "../lib/board";
import { issueActionBody, issueActionRoute } from "../lib/issue-actions";
import { issueParamFromSearch } from "../lib/issue-param";
import { workItemIdNumberText } from "../lib/work-item-id";
import { parsePhaseMoveResult } from "../schema";
import type { PhaseMoveTarget } from "../types";

type BoardSearch = { lens?: "deferred"; issue?: string };

export const Route = createFileRoute("/board")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    lens: search.lens === "deferred" ? "deferred" : undefined,
    issue: issueParamFromSearch(search),
  }),
  component: BoardRoute,
});

// The phase board (tickets #146/#148): the shared workflow atom paints it
// from the bundled snapshot and the seam's live read alike, so static builds
// browse the same board. Cards move through the phase-move action and open
// the shared issue panel through the `?issue` param; the deferred lens rides
// `?lens=deferred`.
function BoardRoute() {
  const state = useWorkflowState();
  const mode = useWorkflowMode();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const setIssueParam = (issue: string | undefined) =>
    navigate({ search: (previous) => ({ ...previous, issue }) });

  const movePhase = async (issueId: string, phase: PhaseMoveTarget) => {
    setPendingId(issueId);
    setMessage(null);
    try {
      const action: IssuePanelAction = { kind: "phase-move", issueId, phase };
      const response = await fetch(`/api/workflow/${issueActionRoute(action)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(issueActionBody(action)),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setMessage(failure ?? `The move was rejected (${response.status}).`);
        return;
      }
      // The seam answers with the re-read state, so the card lands in its
      // new column on the next render without a manual reload.
      const result = parsePhaseMoveResult(raw);
      setWorkflowState(result.state);
      setMessage(result.message);
    } catch {
      setMessage("The move did not go through — the dev server API is not reachable.");
    } finally {
      setPendingId(null);
    }
  };

  const columns = useMemo(
    () =>
      board({
        workItems: state.workItems,
        recentlyShipped: state.recentlyShipped,
        blockerEdges: state.blockerEdges,
        maps: state.maps,
        decisionPlacement: state.decisionPlacement,
        warnings: state.warnings,
        deferredLens: search.lens === "deferred",
      }),
    [state, search.lens],
  );

  return (
    <>
      <BoardPage
        columns={columns}
        deferredLens={search.lens === "deferred"}
        mode={mode}
        pendingId={pendingId}
        message={message}
        onLensChange={(deferred) =>
          navigate({
            search: (previous) => ({ ...previous, lens: deferred ? "deferred" : undefined }),
          })
        }
        onOpenIssue={(issueId) => setIssueParam(workItemIdNumberText(issueId))}
        onMovePhase={(issueId, phase) => void movePhase(issueId, phase)}
      />
      <IssuePanelHost issueParam={search.issue} onParamChange={setIssueParam} />
    </>
  );
}
