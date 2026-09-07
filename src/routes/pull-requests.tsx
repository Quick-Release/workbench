import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { PullRequestsPage } from "../components/PullRequestsPage";
import { overviewData } from "../data";

export const Route = createFileRoute("/pull-requests")({
  component: PullRequestsRoute,
});

// The health probe (ticket #37's GET /api/ai/health) decides whether the
// draft actions render enabled; the verdict travels into the page as data
// so the page stays server-render testable in all its states.
function PullRequestsRoute() {
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/health");
      if (!response.ok) throw new Error(String(response.status));
      const { configured } = (await response.json()) as { configured: boolean };
      setAiConfigured(configured);
    } catch {
      setAiConfigured(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <PullRequestsPage pullRequests={overviewData.pullRequests} aiConfigured={aiConfigured} />;
}
