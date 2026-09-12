import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "../components/BoardPage";
import { IssuePanelHost } from "../components/IssuePanelHost";
import { useWorkflowState } from "../hooks/use-workflow-state";
import { board } from "../lib/board";
import { issueParamFromSearch } from "../lib/issue-param";
import { workItemIdNumberText } from "../lib/work-item-id";

type BoardSearch = { lens?: "deferred"; issue?: string };

export const Route = createFileRoute("/board")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    lens: search.lens === "deferred" ? "deferred" : undefined,
    issue: issueParamFromSearch(search),
  }),
  component: BoardRoute,
});

// The read-only phase board (ticket #146): the shared workflow atom paints
// it from the bundled snapshot and the seam's live read alike, so static
// builds browse the same board. Cards open the shared issue panel through
// the `?issue` param; the deferred lens rides `?lens=deferred`.
function BoardRoute() {
  const state = useWorkflowState();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const setIssueParam = (issue: string | undefined) =>
    navigate({ search: (previous) => ({ ...previous, issue }) });

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
        onLensChange={(deferred) =>
          navigate({
            search: (previous) => ({ ...previous, lens: deferred ? "deferred" : undefined }),
          })
        }
        onOpenIssue={(issueId) => setIssueParam(workItemIdNumberText(issueId))}
      />
      <IssuePanelHost issueParam={search.issue} onParamChange={setIssueParam} />
    </>
  );
}
