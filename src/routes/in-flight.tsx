import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { InFlightPage } from "../components/InFlightPage";
import { overviewData } from "../data";
import { workflowStateFrom } from "../lib/workflow-state";
import { parseWorkflowStatePayload } from "../schema";

// The bundled snapshot paints the first render and serves static builds;
// the execution seam's live read replaces it when the dev server answers.
// The view is informational only, so an unreachable seam degrades nothing —
// the snapshot simply stays.
const initialWorkItems = workflowStateFrom(overviewData).workItems;

export const Route = createFileRoute("/in-flight")({
  component: InFlightRoute,
});

function InFlightRoute() {
  const [workItems, setWorkItems] = useState(initialWorkItems);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/workflow");
        if (!response.ok) throw new Error(String(response.status));
        const payload = parseWorkflowStatePayload(await response.json());
        if (!cancelled) setWorkItems(payload.workItems);
      } catch {
        // Keep the bundled snapshot.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <InFlightPage workItems={workItems} />;
}
