import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

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
// malformed probe leaves the verdict unknown rather than guessing. The fetch
// stays a literal /api/ call at each use — the ADR 0005 source scan requires
// it — and this helper only normalizes the degradation to unknown.
const probeVerdict = async <T,>(
  response: Promise<Response>,
  parse: (input: unknown) => T,
): Promise<T | null> => {
  try {
    const ok = await response;
    if (!ok.ok) throw new Error(String(ok.status));
    return parse(await ok.json());
  } catch {
    return null;
  }
};

function PullRequestsRoute() {
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [engineHealth, setEngineHealth] = useState<readonly ReviewEngineHealth[] | null>(null);

  useEffect(() => {
    void probeVerdict(fetch("/api/ai/health"), parseAiHealth).then((verdict) =>
      setAiConfigured(verdict?.configured ?? null),
    );
    void probeVerdict(fetch("/api/review/health"), parseReviewHealth).then((verdict) =>
      setEngineHealth(verdict?.engines ?? null),
    );
  }, []);

  return (
    <PullRequestsPage
      pullRequests={overviewData.pullRequests}
      aiConfigured={aiConfigured}
      engineHealth={engineHealth}
    />
  );
}
