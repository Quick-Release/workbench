import { createFileRoute } from "@tanstack/react-router";

import { InFlightPage } from "../components/InFlightPage";
import { useClarificationRunStates } from "../hooks/use-clarification-run-states";
import { useWorkflowState } from "../hooks/use-workflow-state";

export const Route = createFileRoute("/in-flight")({
  component: InFlightRoute,
});

function InFlightRoute() {
  const state = useWorkflowState();
  const runStates = useClarificationRunStates();
  return <InFlightPage workItems={state.workItems} runStates={runStates} />;
}
