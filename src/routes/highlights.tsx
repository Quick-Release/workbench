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
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(new Set());

  const onSubmit = useCallback(async (candidate: CommitCandidate) => {
    const outcome = await submitHighlight(candidate);
    if (outcome.status === "submitted") {
      setSubmitted((current) => new Set(current).add(candidate.sha));
    }
    return outcome as SubmissionOutcome;
  }, []);

  return (
    <HighlightsPage
      highlights={overviewData.highlights}
      onSubmit={onSubmit}
      submitted={submitted}
    />
  );
}
