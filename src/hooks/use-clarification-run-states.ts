import { useEffect, useState } from "react";

import { parseClarificationRunListResult } from "../schema";

// The In flight run-status chips' read (spec #221, ticket #237): one
// fetch per mount of each issue's latest clarification run state, keyed by
// issue number. Anything but a clean answer — a disabled install, an
// unreachable seam, a static build — yields no chips at all: the view
// stays what it was, informational, never a guessed state.
export const useClarificationRunStates = (): ReadonlyMap<string, string> | null => {
  const [states, setStates] = useState<ReadonlyMap<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/clarification/runs");
        if (!response.ok) return;
        const { runs } = parseClarificationRunListResult((await response.json()) as unknown);
        if (!cancelled) setStates(new Map(runs.map((run) => [run.issueId, run.state])));
      } catch {
        // No seam here: no chips.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return states;
};
