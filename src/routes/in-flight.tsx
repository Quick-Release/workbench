import { createFileRoute } from "@tanstack/react-router";

import { InFlightPage } from "../components/InFlightPage";
import { useWorkflowState } from "../hooks/use-workflow-state";

export const Route = createFileRoute("/in-flight")({
  component: InFlightRoute,
});

function InFlightRoute() {
  const state = useWorkflowState();
  return <InFlightPage workItems={state.workItems} />;
}
