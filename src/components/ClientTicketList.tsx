import { Bug, LifeBuoy } from "lucide-react";

import type { BlockerEdgeRecord, ClientTicketCoverage, WorkItemRecord } from "../types";
import { clientKindFor, clientWaitingReason } from "../lib/client-priority";

// Relative age as plain data — never an SLA: "opened 3d ago", "updated 21d
// ago". The dashboard states what GitHub says, not what it should say.
export const formatAge = (iso: string, now = Date.now()): string => {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
};

// The row every client surface shares (GH-136): the Overview's attention
// section, the Client Tickets page, closed history. Kind, id, and state are
// text and icon — never color alone; unassigned and waiting rows carry an
// explicit word, so emphasis survives narrow widths and screen readers.
export function ClientTicketRow({
  record,
  workItems,
  blockerEdges,
  onOpenIssue,
  closure = false,
}: Readonly<{
  record: WorkItemRecord;
  workItems: readonly WorkItemRecord[];
  blockerEdges: readonly BlockerEdgeRecord[];
  onOpenIssue: (issueId: string) => void;
  closure?: boolean;
}>) {
  const kind = clientKindFor(record);
  const waitingReason = closure ? null : clientWaitingReason(record, workItems, blockerEdges);
  const unassigned = !closure && record.assignees.length === 0;
  const closureLabel =
    record.stateReason === "not_planned"
      ? "closed — not planned"
      : record.stateReason === "completed"
        ? "closed — completed"
        : closure
          ? "closed"
          : null;
  return (
    <li
      data-slot="client-ticket-row"
      data-kind={kind ?? undefined}
      data-waiting={waitingReason ? "1" : undefined}
      data-unassigned={unassigned ? "1" : undefined}
      className="border-b py-2.5 last:border-b-0"
    >
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span
          data-slot="client-ticket-kind"
          className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 font-mono text-[0.65rem] tracking-wide uppercase"
        >
          {kind === "client-bug" ? (
            <>
              <Bug className="size-3" aria-hidden="true" /> client bug
            </>
          ) : kind === "client-feedback" ? (
            <>
              <LifeBuoy className="size-3" aria-hidden="true" /> client request
            </>
          ) : (
            "client ticket"
          )}
        </span>
        <button
          type="button"
          data-open-issue={record.id}
          onClick={() => onOpenIssue(record.id)}
          className="font-medium hover:text-acid"
        >
          {record.title}
        </button>
        <span className="font-mono text-xs text-muted-foreground">{record.id}</span>
        {closureLabel && (
          <span
            data-slot="client-ticket-closure"
            className="font-mono text-xs text-muted-foreground"
          >
            {closureLabel}
          </span>
        )}
        {waitingReason && (
          <span
            data-slot="client-ticket-waiting"
            className="inline-flex items-center gap-1 text-xs text-amber italic"
          >
            {waitingReason}
          </span>
        )}
        {unassigned && (
          <span data-slot="client-ticket-unassigned" className="text-xs text-amber italic">
            unassigned
          </span>
        )}
        {record.assignees.length > 0 && (
          <span className="font-mono text-xs text-muted-foreground">
            {record.assignees.map((assignee) => `@${assignee}`).join(" ")}
          </span>
        )}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        {record.createdAt && <span>opened {formatAge(record.createdAt)}</span>}
        {record.updatedAt && <span>updated {formatAge(record.updatedAt)}</span>}
        <span>triage {record.triageState}</span>
        {record.url && (
          <a
            href={record.url}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-acid"
          >
            GitHub ↗
          </a>
        )}
      </p>
    </li>
  );
}

// The honest-coverage note every client surface shares: incomplete or unknown
// coverage is a visible warning, never a quiet "no tickets".
export function ClientCoverageNote({
  coverage,
}: Readonly<{ coverage: ClientTicketCoverage | undefined }>) {
  if (!coverage)
    return (
      <p data-slot="client-coverage-unknown" className="text-xs text-amber">
        Client coverage unknown — this snapshot predates client discovery. Run sync to learn the
        client state.
      </p>
    );
  if (coverage.complete) return null;
  return (
    <p data-slot="client-coverage-warning" className="text-xs text-amber">
      Client coverage incomplete ({coverage.reasons.join(", ")}) — the lists may be missing tickets.
      Last checked {formatAge(coverage.checkedAt)}.
    </p>
  );
}
