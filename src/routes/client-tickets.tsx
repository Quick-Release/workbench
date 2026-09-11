import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import {
  ClientTicketsPage,
  type ClientLens,
  type ClientOwnership,
} from "../components/ClientTicketsPage";
import { IssuePanelHost } from "../components/IssuePanelHost";
import { useWorkflowMode, useWorkflowState } from "../hooks/use-workflow-state";
import { issueParamFromSearch } from "../lib/issue-param";
import { workItemIdNumberText } from "../lib/work-item-id";
import { parseClosedClientTickets } from "../schema";
import type { ClosedClientTickets } from "../types";

type ClientTicketsSearch = {
  lens: ClientLens;
  ownership: ClientOwnership;
  waiting: boolean;
  q: string;
  issue: string | undefined;
};

// The view's grammar (GH-136): lens (bugs / feedback / closed; absent = all),
// ownership, the waiting/blocked toggle, text search, and the shared panel's
// `?issue=NN` param — all URL-backed, all deep-linkable.
export const Route = createFileRoute("/client-tickets")({
  validateSearch: (search: Record<string, unknown>): ClientTicketsSearch => ({
    lens:
      search.lens === "bugs" || search.lens === "feedback" || search.lens === "closed"
        ? search.lens
        : undefined,
    ownership:
      search.ownership === "unassigned" || search.ownership === "assigned"
        ? search.ownership
        : "all",
    waiting: search.waiting === "1" || search.waiting === "true",
    q: typeof search.q === "string" ? search.q : "",
    issue: issueParamFromSearch(search),
  }),
  component: ClientTicketsRoute,
});

function ClientTicketsRoute() {
  const state = useWorkflowState();
  const mode = useWorkflowMode();
  const navigate = Route.useNavigate();
  const lens = Route.useSearch({ select: (s) => s.lens });
  const ownership = Route.useSearch({ select: (s) => s.ownership });
  const waiting = Route.useSearch({ select: (s) => s.waiting });
  const q = Route.useSearch({ select: (s) => s.q });
  const issueParam = Route.useSearch({ select: (s) => s.issue });

  const setIssueParam = useCallback(
    (issue: string | undefined) => navigate({ search: (prev) => ({ ...prev, issue }) }),
    [navigate],
  );

  // The closed lens is a bounded seam read, fetched when the lens opens and
  // cached until the explicit refresh — never on page load, never a sweep.
  const [closed, setClosed] = useState<ClosedClientTickets | null>(null);
  const [closedPending, setClosedPending] = useState(false);
  const [closedError, setClosedError] = useState<string | null>(null);
  const closedLoaded = useRef(false);

  const loadClosed = useCallback(async () => {
    setClosedPending(true);
    setClosedError(null);
    try {
      const response = await fetch("/api/client-tickets/closed");
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setClosedError(failure ?? `The closed history was rejected (${response.status}).`);
        return;
      }
      setClosed(parseClosedClientTickets(raw));
      closedLoaded.current = true;
    } catch {
      setClosedError("The closed history did not load — the dev server API is not reachable.");
    } finally {
      setClosedPending(false);
    }
  }, []);

  useEffect(() => {
    if (lens !== "closed" || mode !== "live" || closedLoaded.current) return;
    void loadClosed();
  }, [lens, mode, loadClosed]);

  return (
    <>
      <ClientTicketsPage
        state={state}
        mode={mode}
        lens={lens}
        ownership={ownership}
        waiting={waiting}
        q={q}
        onLensChange={(next) =>
          navigate({ search: (prev) => ({ ...prev, lens: next ?? undefined }) })
        }
        onOwnershipChange={(next) => navigate({ search: (prev) => ({ ...prev, ownership: next }) })}
        onWaitingChange={(next) => navigate({ search: (prev) => ({ ...prev, waiting: next }) })}
        onQueryChange={(next) => navigate({ search: (prev) => ({ ...prev, q: next }) })}
        onOpenIssue={(issueId) => setIssueParam(workItemIdNumberText(issueId))}
        closed={closed}
        closedPending={closedPending}
        closedError={closedError}
        onRefreshClosed={() => {
          closedLoaded.current = false;
          void loadClosed();
        }}
      />
      <IssuePanelHost
        issueParam={issueParam}
        onParamChange={setIssueParam}
        onCreated={setIssueParam}
      />
    </>
  );
}
