import { createFileRoute } from "@tanstack/react-router";

import { BlockersPage } from "../components/BlockersPage";
import { IssuePanelHost } from "../components/IssuePanelHost";
import { useWorkflowState } from "../hooks/use-workflow-state";
import {
  expandParamFromSearch,
  focusParamFromSearch,
  issueParamFromSearch,
  mapParamFromSearch,
} from "../lib/issue-param";
import { workItemIdNumberText } from "../lib/work-item-id";

type BlockersSearch = {
  map?: string;
  focus?: string;
  issue?: string;
  expand?: boolean;
};

// The blocker graph view (ticket #61): `?map` selects the map, `?focus`
// deep-links a node — the shared panel's show-in-graph target — `?issue`
// opens the panel, and `?expand` holds the closed tier open.
export const Route = createFileRoute("/blockers")({
  validateSearch: (search: Record<string, unknown>): BlockersSearch => ({
    map: mapParamFromSearch(search),
    focus: focusParamFromSearch(search),
    issue: issueParamFromSearch(search),
    expand: expandParamFromSearch(search) || undefined,
  }),
  component: BlockersRoute,
});

function BlockersRoute() {
  const state = useWorkflowState();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const setSearch = (next: Partial<BlockersSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...next }) });

  return (
    <>
      <BlockersPage
        maps={state.maps}
        workItems={state.workItems}
        blockerEdges={state.blockerEdges}
        mapId={search.map ?? null}
        focusId={search.focus ?? null}
        expandClosed={search.expand ?? false}
        onMapChange={(mapId) => setSearch({ map: mapId })}
        onExpandClosedChange={(expanded) => setSearch({ expand: expanded || undefined })}
        onOpenIssue={(issueId) => setSearch({ issue: workItemIdNumberText(issueId) })}
      />
      <IssuePanelHost issueParam={search.issue} onParamChange={(issue) => setSearch({ issue })} />
    </>
  );
}
