import { useEffect, useState } from "react";

import { parseClarificationRunsListResult } from "../schema";
import type { ClarificationRunSummary } from "../types";

// The In flight run chips' client (spec #221, ticket #237): one read of
// every run's identity and lifecycle word. The chips render zero actions —
// the issue panel is where anything actionable lives — and an unreachable
// seam or a dormant install renders no chips at all, never a guessed
// absence of runs.
export const useClarificationRuns = () => {
  const [runs, setRuns] = useState<readonly ClarificationRunSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/clarification/runs");
        if (!response.ok) {
          if (!cancelled) setRuns(null);
          return;
        }
        const parsed = parseClarificationRunsListResult((await response.json()) as unknown);
        if (!cancelled) setRuns(parsed.runs);
      } catch {
        // The seam is unreachable (or this is a static build): no chips
        // rather than pretending.
        if (!cancelled) setRuns(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return runs;
};
