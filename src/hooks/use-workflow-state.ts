import { useEffect, useState } from "react";

import { overviewData } from "../data";
import { workflowStateFrom } from "../lib/workflow-state";
import { parseWorkflowStatePayload } from "../schema";
import type { WorkflowStatePayload } from "../types";

// The bundled snapshot paints the first render and serves static builds; the
// execution seam's live read replaces it when the dev server answers. An
// unreachable seam degrades nothing — the snapshot simply stays.
const initialWorkflowState = workflowStateFrom(overviewData);

export const useWorkflowState = (): WorkflowStatePayload => {
  const [state, setState] = useState<WorkflowStatePayload>(initialWorkflowState);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/workflow");
        if (!response.ok) throw new Error(String(response.status));
        const payload = parseWorkflowStatePayload(await response.json());
        if (!cancelled) setState(payload);
      } catch {
        // Keep the bundled snapshot.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
};
