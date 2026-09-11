import { useMemo } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ClientCoverageNote, ClientTicketRow, formatAge } from "@/components/ClientTicketList";
import { clientAttention, clientWaitingReason } from "@/lib/client-priority";
import { workItemIdNumberText } from "@/lib/work-item-id";

import type { ClosedClientTickets, WorkItemRecord, WorkflowStatePayload } from "../types";

// The Client Tickets lens (GH-136): which tickets the list shows — the two
// client tiers, all of them, or the bounded closed history.
export type ClientLens = "bugs" | "feedback" | "closed" | undefined;
export type ClientOwnership = "all" | "unassigned" | "assigned";

const LENSES = [
  { value: undefined, label: "All" },
  { value: "bugs" as const, label: "Bugs" },
  { value: "feedback" as const, label: "Feedback & requests" },
  { value: "closed" as const, label: "Closed" },
];

const OWNERSHIPS = [
  { value: "all" as const, label: "Anyone" },
  { value: "unassigned" as const, label: "Unassigned" },
  { value: "assigned" as const, label: "Assigned" },
];

export function ClientTicketsPage({
  state,
  mode,
  lens,
  ownership,
  waiting,
  q,
  onLensChange,
  onOwnershipChange,
  onWaitingChange,
  onQueryChange,
  onOpenIssue,
  closed,
  closedPending,
  closedError,
  onRefreshClosed,
}: Readonly<{
  state: WorkflowStatePayload;
  mode: "live" | "static";
  lens: ClientLens;
  ownership: ClientOwnership;
  waiting: boolean;
  q: string;
  onLensChange: (lens: ClientLens) => void;
  onOwnershipChange: (ownership: ClientOwnership) => void;
  onWaitingChange: (waiting: boolean) => void;
  onQueryChange: (q: string) => void;
  onOpenIssue: (issueId: string) => void;
  closed: ClosedClientTickets | null;
  closedPending: boolean;
  closedError: string | null;
  onRefreshClosed: () => void;
}>) {
  // The unfiltered open totals stay visible whatever the filters narrow.
  const { bugs, feedback } = useMemo(() => clientAttention(state.workItems), [state.workItems]);
  const rows = useMemo(() => {
    if (lens === "closed") return closed?.tickets ?? [];
    const all = lens === "bugs" ? bugs : lens === "feedback" ? feedback : [...bugs, ...feedback];
    const needle = q.trim().toLowerCase();
    return all.filter((record) => {
      if (ownership === "unassigned" && record.assignees.length > 0) return false;
      if (ownership === "assigned" && record.assignees.length === 0) return false;
      if (waiting && clientWaitingReason(record, state.workItems, state.blockerEdges) === null)
        return false;
      if (needle && !matchesQuery(record, needle)) return false;
      return true;
    });
  }, [lens, bugs, feedback, closed, ownership, waiting, q, state.workItems, state.blockerEdges]);

  return (
    <>
      <section aria-label="Client tickets" className="flex flex-col gap-4">
        <Card
          data-slot="client-tickets"
          className="gap-3 rounded-none border-line bg-panel/90 p-[22px] shadow-panel"
        >
          <div className="flex flex-wrap items-baseline gap-x-3">
            <p className="section-kicker">Client tickets</p>
            <p
              data-slot="client-open-totals"
              className="text-xs text-muted-foreground"
              aria-label={`${bugs.length} open client bugs, ${feedback.length} open client requests`}
            >
              {bugs.length} open {bugs.length === 1 ? "bug" : "bugs"} · {feedback.length} open{" "}
              {feedback.length === 1 ? "request" : "requests"} — totals never hide behind a filter
            </p>
          </div>

          <ClientCoverageNote coverage={state.clientCoverage} />

          <div className="flex flex-wrap items-center gap-2" data-slot="client-filters">
            <div role="group" aria-label="Ticket lens" className="flex flex-wrap gap-1">
              {LENSES.map(({ value, label }) => (
                <button
                  key={label}
                  type="button"
                  data-slot="client-lens"
                  data-lens={value ?? "all"}
                  aria-pressed={(value ?? undefined) === (lens ?? undefined)}
                  onClick={() => onLensChange(value)}
                  className={`rounded border px-2 py-1 text-xs hover:border-acid ${
                    (value ?? undefined) === (lens ?? undefined)
                      ? "border-line-strong bg-panel-hi font-medium"
                      : "border-line text-muted-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div role="group" aria-label="Ownership" className="flex flex-wrap gap-1">
              {OWNERSHIPS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  data-slot="client-ownership"
                  data-ownership={value}
                  aria-pressed={ownership === value}
                  onClick={() => onOwnershipChange(value)}
                  className={`rounded border px-2 py-1 text-xs hover:border-acid ${
                    ownership === value
                      ? "border-line-strong bg-panel-hi font-medium"
                      : "border-line text-muted-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                data-slot="client-waiting-filter"
                checked={waiting}
                onChange={(event) => onWaitingChange(event.target.checked)}
              />
              waiting / blocked only
            </label>
            <Input
              type="search"
              data-slot="client-search"
              value={q}
              placeholder="Search title or number…"
              aria-label="Search client tickets"
              className="h-7 w-48 text-xs"
              onChange={(event) => onQueryChange(event.target.value)}
            />
            {lens === "closed" && mode === "live" && (
              <Button
                type="button"
                data-slot="client-closed-refresh"
                size="sm"
                variant="outline"
                disabled={closedPending}
                onClick={onRefreshClosed}
              >
                {closedPending ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                )}
                Refresh history
              </Button>
            )}
          </div>

          {lens === "closed" ? (
            <ClosedLensBody
              mode={mode}
              closed={closed}
              closedPending={closedPending}
              closedError={closedError}
              state={state}
              onOpenIssue={onOpenIssue}
            />
          ) : rows.length > 0 ? (
            <ul data-slot="client-ticket-list" className="flex flex-col">
              {rows.map((record) => (
                <ClientTicketRow
                  key={record.id}
                  record={record}
                  workItems={state.workItems}
                  blockerEdges={state.blockerEdges}
                  onOpenIssue={onOpenIssue}
                />
              ))}
            </ul>
          ) : (
            <p data-slot="client-tickets-empty" className="text-sm text-muted-foreground">
              {bugs.length + feedback.length === 0
                ? "No open client tickets — internal work is not gated."
                : "No client tickets match these filters — the totals above still count everything open."}
            </p>
          )}
        </Card>
      </section>
    </>
  );
}

function ClosedLensBody({
  mode,
  closed,
  closedPending,
  closedError,
  state,
  onOpenIssue,
}: Readonly<{
  mode: "live" | "static";
  closed: ClosedClientTickets | null;
  closedPending: boolean;
  closedError: string | null;
  state: WorkflowStatePayload;
  onOpenIssue: (issueId: string) => void;
}>) {
  if (mode === "static")
    return (
      <p data-slot="client-closed-static" className="text-sm text-muted-foreground">
        Closed history needs the dev server's execution seam — the static snapshot carries open
        tickets only.
      </p>
    );
  if (closedError)
    return (
      <p data-slot="client-closed-error" className="text-sm text-amber">
        {closedError}
      </p>
    );
  if (closedPending && !closed)
    return (
      <p
        data-slot="client-closed-loading"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Loading closed client
        tickets…
      </p>
    );
  if (!closed) return null;
  if (closed.tickets.length === 0)
    return (
      <p data-slot="client-closed-empty" className="text-sm text-muted-foreground">
        No closed client tickets in the bounded history (one page per client label, most recently
        updated first). A capped or failed read would warn above — absence here is absence, not a
        guess.
      </p>
    );
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        Bounded history — the {closed.tickets.length} most recently updated closed client tickets,
        fetched {formatAge(closed.coverage.checkedAt)}. Completed and not-planned closures are named
        as GitHub names them.
      </p>
      <ul data-slot="client-closed-list" className="flex flex-col">
        {closed.tickets.map((record: WorkItemRecord) => (
          <ClientTicketRow
            key={record.id}
            record={record}
            workItems={state.workItems}
            blockerEdges={state.blockerEdges}
            onOpenIssue={onOpenIssue}
            closure
          />
        ))}
      </ul>
    </div>
  );
}

const matchesQuery = (record: WorkItemRecord, needle: string) =>
  record.title.toLowerCase().includes(needle) ||
  record.id.toLowerCase().includes(needle) ||
  workItemIdNumberText(record.id).includes(needle);
