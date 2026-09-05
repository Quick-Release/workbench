import { createColumnHelper, flexRender, useTable } from "@tanstack/react-table";

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from "@/components/ui/table";

import { ProgressBar } from "./ProgressBar";
import {
  SortButton,
  sortableBodyCellClass,
  sortableBodyRowClass,
  sortableHeadClass,
  tableEmptyCellClass,
} from "./sortable-table";
import { statusSortFn, sortableTableFeatures } from "../lib/table";
import type { TicketRecord } from "../types";
import { StatusBadge } from "./StatusBadge";

const ticketHelper = createColumnHelper<typeof sortableTableFeatures, TicketRecord>();

const ticketColumns = ticketHelper.columns([
  ticketHelper.accessor("id", {
    id: "ticket",
    header: "Ticket",
    cell: ({ row }) => <TicketTitleCell ticket={row.original} />,
  }),
  ticketHelper.accessor("status", {
    id: "status",
    header: "Status",
    sortFn: statusSortFn,
    cell: ({ row }) => <TicketStatusCell ticket={row.original} />,
  }),
  ticketHelper.accessor("group", {
    id: "stream",
    header: "Stream / lane",
    cell: ({ row }) => <TicketStreamCell ticket={row.original} />,
  }),
  ticketHelper.accessor(
    (ticket) =>
      ticket.progress.total > 0 ? ticket.progress.done / ticket.progress.total : undefined,
    {
      id: "progress",
      header: "Progress",
      sortFn: "basic",
      sortUndefined: "last",
      cell: ({ row }) => <TicketProgressCell ticket={row.original} />,
    },
  ),
]);

const cellClassNames: Partial<Record<string, string>> = {
  ticket: "ticket-title-cell",
};

export function TicketTable({
  tickets,
  total,
}: Readonly<{
  tickets: readonly TicketRecord[];
  total: number;
}>) {
  const table = useTable({
    features: sortableTableFeatures,
    columns: ticketColumns,
    data: tickets,
    getRowId: (ticket) => ticket.id,
  });
  const rows = table.getRowModel().rows;

  return (
    <section className="content-section" id="tickets">
      <div className="section-heading">
        <div>
          <p className="section-kicker">01 / ticket ledger</p>
          <h2>
            Work that still needs a <em>decision.</em>
          </h2>
        </div>
        <p>
          Every implementation record in the planning corpus plus read-only tasks from configured
          services, with canonical status kept distinct from plan-file status.
        </p>
      </div>
      <div className="result-line" aria-live="polite">
        <span>
          Showing <strong>{tickets.length}</strong> of {total} ticket records
        </span>
        <span className="result-hint">Select a status or stream above to narrow the view.</span>
      </div>
      <div className="table-shell">
        <Table className="min-w-[1050px] border-collapse">
          <caption className="sr-only">Implementation tickets and external tasks</caption>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={sortableHeadClass}
                    >
                      {header.isPlaceholder ? null : (
                        <SortButton
                          sorted={sorted}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </SortButton>
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="border-b-0 hover:bg-transparent">
                <TableCell colSpan={ticketColumns.length} className={tableEmptyCellClass}>
                  No tickets match this lens. Clear the filters to restore the full ledger.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id} className={sortableBodyRowClass}>
                  {row.getAllCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={[sortableBodyCellClass, cellClassNames[cell.column.id]]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function TicketTitleCell({ ticket }: Readonly<{ ticket: TicketRecord }>) {
  return (
    <>
      <div className="ticket-meta">
        {ticket.sourceUrl ? (
          <a className="ticket-id" href={ticket.sourceUrl} target="_blank" rel="noreferrer">
            {ticket.id} <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <span className="ticket-id">{ticket.id}</span>
        )}
        <span className="kind-label">
          {ticket.kind === "ledger"
            ? "canonical ledger"
            : ticket.kind === "plan-ticket"
              ? "plan ticket"
              : ticket.externalSource || "external task"}
        </span>
      </div>
      <strong>{ticket.title}</strong>
      <p>{ticket.summary}</p>
      <code className="source-path">{ticket.sourcePath}</code>
    </>
  );
}

function TicketStatusCell({ ticket }: Readonly<{ ticket: TicketRecord }>) {
  return (
    <>
      <StatusBadge status={ticket.status} label={ticket.statusLabel} />
      {ticket.statusDetail && ticket.statusDetail !== ticket.statusLabel && (
        <small className="status-detail">{ticket.statusDetail}</small>
      )}
    </>
  );
}

function TicketStreamCell({ ticket }: Readonly<{ ticket: TicketRecord }>) {
  return (
    <>
      <strong className="stream-name">{ticket.group}</strong>
      <small className="block text-[0.76rem] leading-[1.45] text-muted-foreground">
        {ticket.lane}
      </small>
    </>
  );
}

function TicketProgressCell({ ticket }: Readonly<{ ticket: TicketRecord }>) {
  if (ticket.progress.total === 0) {
    return <small className="muted-copy">No checklist</small>;
  }
  return (
    <div className="progress-cell">
      <ProgressBar value={Math.round((ticket.progress.done / ticket.progress.total) * 100)} />
      <small className="block text-[0.76rem] leading-[1.45] text-muted-foreground">
        {ticket.progress.done}/{ticket.progress.total} checked
      </small>
    </div>
  );
}
