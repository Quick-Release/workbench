import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { HighlightsPage } from "../components/HighlightsPage";
import { submitHighlight } from "../lib/submissions";
import type { SubmissionOutcome } from "../lib/submissions";
import { overviewData } from "../data";
import type { CommitCandidate } from "../types";

export const Route = createFileRoute("/highlights")({
  component: HighlightsRoute,
});

// Renders the synced highlight candidates (ticket #17) and carries their
// one action (ticket #12): Submit POSTs the candidate through the
// localhost seam — the dev server attaches the ingest token server-side —
// and the outcome is confirmed per candidate immediately.
function HighlightsRoute() {
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, SubmissionOutcome>>(new Map());

  const onSubmit = useCallback(async (candidate: CommitCandidate) => {
    const outcome = await submitHighlight(candidate);
    setOutcomes((current) => new Map(current).set(candidate.sha, outcome));
    return outcome;
  }, []);

  return (
    <HighlightsPage highlights={overviewData.highlights} onSubmit={onSubmit} outcomes={outcomes} />
  );
}
