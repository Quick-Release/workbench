import { createFileRoute } from "@tanstack/react-router";

import { InFlightPage } from "../components/InFlightPage";
import { useClarificationRuns } from "../hooks/use-clarification-runs";
import { useWorkflowState } from "../hooks/use-workflow-state";

export const Route = createFileRoute("/in-flight")({
  component: InFlightRoute,
});

function InFlightRoute() {
  const state = useWorkflowState();
  const runs = useClarificationRuns();
  return <InFlightPage workItems={state.workItems} runs={runs ?? undefined} />;
}
