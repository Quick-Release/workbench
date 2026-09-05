import { createFileRoute } from "@tanstack/react-router";

import { DecisionsPage } from "../components/DecisionsPage";
import { overviewData } from "../data";
import { useWorkflowState } from "../hooks/use-workflow-state";

export const Route = createFileRoute("/decisions")({
  component: DecisionsRoute,
});

function DecisionsRoute() {
  const state = useWorkflowState();
  return (
    <DecisionsPage
      decisions={state.decisions}
      artifacts={state.artifacts}
      repositoryUrl={overviewData.meta.repositoryUrl}
    />
  );
}
