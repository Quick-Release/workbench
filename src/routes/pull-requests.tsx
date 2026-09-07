import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { PullRequestsPage } from "../components/PullRequestsPage";
import { overviewData } from "../data";
import { parseAiHealth } from "../schema";

export const Route = createFileRoute("/pull-requests")({
  component: PullRequestsRoute,
});

// The health probe (ticket #37's GET /api/ai/health) decides whether the
// draft actions render enabled; the verdict travels into the page as data
// so the page stays server-render testable in all its states. The payload
// passes the Effect Schema boundary (ADR 0005); an unreachable or malformed
// probe leaves the verdict unknown rather than guessing.
function PullRequestsRoute() {
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/ai/health");
      if (!response.ok) throw new Error(String(response.status));
      setAiConfigured(parseAiHealth(await response.json()).configured);
    } catch {
      setAiConfigured(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <PullRequestsPage pullRequests={overviewData.pullRequests} aiConfigured={aiConfigured} />;
}
