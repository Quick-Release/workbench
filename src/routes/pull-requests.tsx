import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { PullRequestsPage } from "../components/PullRequestsPage";
import { overviewData } from "../data";
import { parseAiHealth, parseReviewHealth } from "../schema";
import type { ReviewEngineHealth } from "../types";

export const Route = createFileRoute("/pull-requests")({
  component: PullRequestsRoute,
});

// The health probes decide what the page enables: ticket #37's
// GET /api/ai/health for the draft actions, ticket #24's
// GET /api/review/health for the review engines. Both verdicts travel into
// the page as data so it stays server-render testable in all its states, and
// both payloads pass the Effect Schema boundary (ADR 0005); an unreachable or
// malformed probe leaves the verdict unknown rather than guessing.
function PullRequestsRoute() {
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [reviewHealth, setReviewHealth] = useState<readonly ReviewEngineHealth[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/health");
      if (!response.ok) throw new Error(String(response.status));
      setAiConfigured(parseAiHealth(await response.json()).configured);
    } catch {
      setAiConfigured(null);
    }
  }, []);

  const refreshReviewHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/review/health");
      if (!response.ok) throw new Error(String(response.status));
      setReviewHealth(parseReviewHealth(await response.json()).engines);
    } catch {
      setReviewHealth(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshReviewHealth();
  }, [refresh, refreshReviewHealth]);

  return (
    <PullRequestsPage
      pullRequests={overviewData.pullRequests}
      aiConfigured={aiConfigured}
      reviewHealth={reviewHealth}
    />
  );
}
