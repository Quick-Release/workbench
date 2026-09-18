import { useEffect, useState } from "react";

import { parseClarificationStatusResult } from "../schema";
import type { ClarificationStatusResult } from "../types";

// The Owned-clarification posture read (spec #221, ticket #222): one fetch
// per mount, feeding the issue panel's hiding rule. Anything that is not a
// clean, enabled answer — disabled, invalid, unreachable seam, static
// build — renders no clarification affordance at all, so every failure
// mode degrades to the capability not being there.
export const useClarificationPosture = (): ClarificationStatusResult | null => {
  const [posture, setPosture] = useState<ClarificationStatusResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/clarification");
        if (!response.ok) return;
        const parsed = parseClarificationStatusResult((await response.json()) as unknown);
        if (!cancelled) setPosture(parsed);
      } catch {
        // The seam is unreachable (or this is a static build): no affordance.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return posture;
};
