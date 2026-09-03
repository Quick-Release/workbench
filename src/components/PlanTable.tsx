import { createColumnHelper, flexRender, useTable } from "@tanstack/react-table";

import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

import { statusSortFn, sortableTableFeatures } from "../lib/table";
import type { PlanRecord } from "../types";
import { StatusBadge } from "./StatusBadge";

const planHelper = createColumnHelper<typeof sortableTableFeatures, PlanRecord>();

const planColumns = planHelper.columns([
  planHelper.accessor("id", {
    id: "source",
    header: "Source",
    cell: ({ row }) => <PlanSourceCell plan={row.original} />,
  }),
  planHelper.accessor("status", {
    id: "status",
    header: "Status",
    sortFn: statusSortFn,
    cell: ({ row }) => <PlanStatusCell plan={row.original} />,
  }),
  planHelper.accessor("ticketCount", {
    id: "load",
    header: "Ticket load",
    sortFn: "basic",
    cell: ({ row }) => <PlanLoadCell plan={row.original} />,
  }),
  planHelper.accessor("stream", {
    id: "about",
    header: "What it is about",
    cell: ({ row }) => <PlanAboutCell plan={row.original} />,
  }),
]);

const cellClassNames: Partial<Record<string, string>> = {
  source: "plan-title-cell",
  load: "plan-load-cell",
};

export function PlanTable({
  plans,
  total,
}: Readonly<{
  plans: readonly PlanRecord[];
  total: number;
}>) {
  const table = useTable({
    features: sortableTableFeatures,
    columns: planColumns,
    data: plans,
    getRowId: (plan) => plan.id,
  });
  const rows = table.getRowModel().rows;

  return (
    <section className="content-section" id="plans">
      <div className="section-heading">
        <div>
          <p className="section-kicker">02 / source corpus</p>
          <h2>
            The plans behind the <em>queue.</em>
          </h2>
        </div>
        <p>
          Top-level planning sources are summarized here so a ticket never loses the context, owner,
          or workstream it came from.
        </p>
      </div>
      <div className="result-line" aria-live="polite">
        <span>
          Showing <strong>{plans.length}</strong> of {total} plan sources
        </span>
        <span className="result-hint">Counts are derived from local Markdown files.</span>
      </div>
      <div className="table-shell">
        <Table className="min-w-[1050px] border-collapse">
          <caption className="sr-only">Local planning source documents</caption>
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
                      className="sticky top-0 z-[2] h-auto bg-panel-hi/97 px-[15px] py-3.5 align-top font-mono text-[0.64rem] font-normal tracking-[0.08em] uppercase text-faint"
                    >
                      {header.isPlaceholder ? null : (
                        <button
                          type="button"
                          className={cn(
                            "inline-flex cursor-pointer items-center gap-1.5 border-0 bg-none p-0 text-left hover:text-acid focus-visible:text-acid",
                            sorted && "text-acid",
                          )}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span
                            aria-hidden="true"
                            className={cn("text-[0.5rem]", sorted ? "opacity-100" : "opacity-40")}
                          >
                            {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
                          </span>
                        </button>
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
                <TableCell
                  colSpan={planColumns.length}
                  className="p-[35px] text-center text-muted-foreground"
                >
                  No plan sources match this lens.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id} className="hover:bg-acid/3">
                  {row.getAllCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        "border-b-0 px-[15px] py-3.5 align-top whitespace-normal",
                        cellClassNames[cell.column.id],
                      )}
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

function PlanSourceCell({ plan }: Readonly<{ plan: PlanRecord }>) {
  return (
    <>
      <a className="plan-id" href={plan.sourceUrl} target="_blank" rel="noreferrer">
        {plan.id} <span aria-hidden="true">↗</span>
      </a>
      <strong>{plan.title}</strong>
      <code className="source-path">{plan.sourcePath}</code>
    </>
  );
}

function PlanStatusCell({ plan }: Readonly<{ plan: PlanRecord }>) {
  return (
    <>
      <StatusBadge status={plan.status} label={plan.statusLabel} />
      {plan.statusDetail && plan.statusDetail !== plan.statusLabel && (
        <small className="status-detail">{plan.statusDetail}</small>
      )}
    </>
  );
}

function PlanLoadCell({ plan }: Readonly<{ plan: PlanRecord }>) {
  const progress =
    plan.ticketCount === 0 ? 0 : Math.round((plan.completeTicketCount / plan.ticketCount) * 100);
  return (
    <>
      <strong>{plan.ticketCount}</strong>
      <span>
        {plan.openTicketCount} open / {plan.completeTicketCount} complete
      </span>
      <Progress
        value={progress}
        aria-label={`${progress}% of plan tickets complete`}
        className="h-[5px] rounded-none bg-panel-hi"
      />
    </>
  );
}

function PlanAboutCell({ plan }: Readonly<{ plan: PlanRecord }>) {
  return (
    <>
      <span className="stream-chip">{plan.stream}</span>
      <p className="plan-summary">{plan.summary}</p>
    </>
  );
}
