import { createFileRoute } from "@tanstack/react-router";

import { HighlightsPage } from "../components/HighlightsPage";
import { overviewData } from "../data";

export const Route = createFileRoute("/highlights")({
  component: HighlightsRoute,
});

// Renders the synced highlight candidates (ticket #17): the page draws
// straight from the generated snapshot, so it works offline and collects
// nothing — the consent posture lives in the page's explainer card.
function HighlightsRoute() {
  return <HighlightsPage highlights={overviewData.highlights} />;
}
