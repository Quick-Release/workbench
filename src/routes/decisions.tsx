import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { DecisionsPage } from "../components/DecisionsPage";
import { overviewData } from "../data";
import { workflowStateFrom } from "../lib/workflow-state";
import { parseWorkflowStatePayload } from "../schema";

// The bundled snapshot paints the first render and serves static builds;
// the execution seam's live read replaces it when the dev server answers.
const initialState = workflowStateFrom(overviewData);

export const Route = createFileRoute("/decisions")({
  component: DecisionsRoute,
});

function DecisionsRoute() {
  const [state, setState] = useState({
    decisions: initialState.decisions,
    artifacts: initialState.artifacts,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/workflow");
        if (!response.ok) throw new Error(String(response.status));
        const payload = parseWorkflowStatePayload(await response.json());
        if (!cancelled) setState({ decisions: payload.decisions, artifacts: payload.artifacts });
      } catch {
        // Keep the bundled snapshot.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <DecisionsPage decisions={state.decisions} artifacts={state.artifacts} />;
}
