import { createFileRoute } from "@tanstack/react-router";

import { BlockersPage } from "../components/BlockersPage";
import { IssueDetailPanel } from "../components/IssueDetailPanel";
import { useIssueActionRunner } from "../hooks/use-issue-actions";
import { useWorkflowMode, useWorkflowState } from "../hooks/use-workflow-state";
import {
  effortParamFromSearch,
  expandParamFromSearch,
  focusParamFromSearch,
  issueParamFromSearch,
  panelIdFor,
} from "../lib/issue-param";

type BlockersSearch = {
  effort?: string;
  focus?: string;
  issue?: string;
  expand?: boolean;
};

// The blocker graph view (ticket #61): `?effort` selects the map, `?focus`
// deep-links a node — the shared panel's show-in-graph target — `?issue`
// opens the panel, and `?expand` holds the closed tier open.
export const Route = createFileRoute("/blockers")({
  validateSearch: (search: Record<string, unknown>): BlockersSearch => ({
    effort: effortParamFromSearch(search),
    focus: focusParamFromSearch(search),
    issue: issueParamFromSearch(search),
    expand: expandParamFromSearch(search) || undefined,
  }),
  component: BlockersRoute,
});

function BlockersRoute() {
  const state = useWorkflowState();
  const mode = useWorkflowMode();
  const {
    pending: panelPending,
    message: panelMessage,
    run: runIssueAction,
  } = useIssueActionRunner();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const panelIssueId = panelIdFor(search.issue);

  const setSearch = (next: Partial<BlockersSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...next }) });

  return (
    <>
      <BlockersPage
        maps={state.maps}
        workItems={state.workItems}
        blockerEdges={state.blockerEdges}
        effortId={search.effort ?? null}
        focusId={search.focus ?? null}
        expandClosed={search.expand ?? false}
        onEffortChange={(mapId) => setSearch({ effort: mapId })}
        onExpandClosedChange={(expanded) => setSearch({ expand: expanded || undefined })}
        onOpenIssue={(issueId) => setSearch({ issue: issueId.slice(3) })}
      />
      <IssueDetailPanel
        issueId={panelIssueId}
        state={state}
        mode={mode}
        pending={panelPending}
        message={panelMessage}
        onOpenChange={(open) => {
          if (!open) setSearch({ issue: undefined });
        }}
        onAction={(action) => void runIssueAction(action)}
      />
    </>
  );
}
