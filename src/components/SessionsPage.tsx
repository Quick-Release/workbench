import { useMemo } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { sessionHandoffs } from "@/lib/session-handoffs";
import type { SessionHandoffForest, SessionHandoffNode } from "@/lib/session-handoffs";
import { cn } from "@/lib/utils";

import { MetricCard } from "./MetricCard";
import { sortableTableFeatures } from "@/lib/table";
import { createColumnHelper, flexRender, useTable } from "@tanstack/react-table";
import type { OverviewData, SessionUsageModelRow, SessionUsageRecord } from "../types";

export type SessionsLens = "all" | "interactive" | "subagents" | "handoffs";

export type SessionsSearch = { subagents: SessionsLens };

const lensOptions = [
  ["all", "All sessions"],
  ["interactive", "Interactive"],
  ["subagents", "Subagents"],
  ["handoffs", "Handoffs"],
] as const;

// Model series colors cycle through the theme accent triads.
const seriesColors = [
  "var(--color-acid)",
  "var(--color-blue)",
  "var(--color-amber)",
  "var(--color-coral)",
] as const;

const compact = new Intl.NumberFormat("en", { notation: "compact" });
const compactNumber = (value: number) => compact.format(value);

const modelDuration = (ms: number) => {
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
};

const modelName = (row: { provider: string; model: string }) =>
  row.provider ? `${row.model} · ${row.provider}` : row.model;

export function SessionsPage({
  data,
  search,
  onSearchChange,
}: Readonly<{
  data: OverviewData;
  search: SessionsSearch;
  onSearchChange: (next: Partial<SessionsSearch>) => void;
}>) {
  const usage = data.sessions;
  const models = usage.perModel;
  const totals = useMemo(
    () => ({
      requests: models.reduce((sum, row) => sum + row.requests, 0),
      outputTokens: models.reduce((sum, row) => sum + row.outputTokens, 0),
      inputTokens: models.reduce((sum, row) => sum + row.inputTokens, 0),
    }),
    [models],
  );
  const visibleSessions = useMemo(() => {
    if (search.subagents === "interactive")
      return usage.sessions.filter((session) => session.taskType !== "subagent_child");
    if (search.subagents === "subagents")
      return usage.sessions.filter((session) => session.taskType === "subagent_child");
    return usage.sessions;
  }, [usage.sessions, search.subagents]);
  const handoffs = useMemo(() => sessionHandoffs(usage.sessions), [usage.sessions]);

  return (
    <>
      {!usage.enabled && (
        <section className="content-section" aria-label="Sessions disabled">
          <Card className="rounded-none border-line bg-panel/90 p-6">
            <CardTitle>Session tracking is off.</CardTitle>
            <CardDescription className="mt-2">
              Enable it with a <code>sessions</code> block in workbench.config.json, then run the
              sync again. The local agent database is only ever read.
            </CardDescription>
          </Card>
        </section>
      )}

      {usage.enabled && (
        <>
          <p className="text-[0.67rem] tracking-[0.14em] text-faint uppercase">
            usage as of <b className="text-muted">{usage.generatedAt.slice(0, 10)}</b>
          </p>
          <section className="metrics" aria-label="Session usage summary">
            <MetricCard value={usage.sessions.length} label="tracked sessions" tone="info" />
            <MetricCard
              value={compactNumber(totals.requests)}
              label="model requests"
              tone="neutral"
            />
            <MetricCard
              value={compactNumber(totals.outputTokens)}
              label="output tokens (code proxy)"
              tone="good"
            />
            <MetricCard value={models.length} label="models in use" tone="hot" />
          </section>

          <section className="content-section" aria-label="Usage charts">
            <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
              <UsageOverTime perDay={usage.perDay} sessionsByDay={usage.sessionsByDay} />
              <ModelShare perModel={models} />
            </div>
          </section>

          {search.subagents === "handoffs" ? (
            <SessionHandoffsSection
              forest={handoffs}
              lens={search.subagents}
              onLensChange={(lens) => onSearchChange({ subagents: lens })}
              total={usage.sessions.length}
            />
          ) : (
            <SessionsTable
              sessions={visibleSessions}
              lens={search.subagents}
              onLensChange={(lens) => onSearchChange({ subagents: lens })}
              total={usage.sessions.length}
            />
          )}
        </>
      )}
    </>
  );
}

function seriesColor(index: number) {
  return seriesColors[index % seriesColors.length];
}

function UsageOverTime({
  perDay,
  sessionsByDay,
}: Readonly<{
  perDay: readonly OverviewData["sessions"]["perDay"][number][];
  sessionsByDay: readonly OverviewData["sessions"]["sessionsByDay"][number][];
}>) {
  const days = [...new Set(perDay.map((row) => row.day))].sort();
  const models = [...new Set(perDay.map((row) => `${row.provider}\u0000${row.model}`))].map(
    (key, index) => {
      const [provider, model] = key.split("\u0000");
      return { provider, model, color: seriesColor(index) };
    },
  );
  const maxTotal = Math.max(
    1,
    ...days.map((day) =>
      perDay.filter((row) => row.day === day).reduce((sum, row) => sum + row.outputTokens, 0),
    ),
  );

  return (
    <Card className="rounded-none border-line bg-panel/90">
      <CardHeader>
        <CardTitle>Output tokens per day</CardTitle>
        <CardDescription>Stacked by model — the "code created" proxy.</CardDescription>
      </CardHeader>
      <CardContent>
        {days.length === 0 ? (
          <p className="text-sm text-muted-foreground">No completed model requests recorded.</p>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${days.length * 44 + 20} 160`}
              role="img"
              aria-label="Output tokens per day, stacked by model"
              className="w-full"
            >
              {days.map((day, dayIndex) => {
                const rows = perDay.filter((row) => row.day === day);
                let offset = 0;
                return (
                  <g key={day}>
                    {rows.map((row) => {
                      const height = (row.outputTokens / maxTotal) * 130;
                      const bar = (
                        <rect
                          key={`${day}-${row.provider}-${row.model}`}
                          x={dayIndex * 44 + 10}
                          y={140 - offset - height}
                          width={28}
                          height={Math.max(height, 1)}
                          fill={seriesColor(
                            models.findIndex(
                              (m) => m.model === row.model && m.provider === row.provider,
                            ),
                          )}
                        >
                          <title>{`${day} · ${modelName(row)} · ${compactNumber(row.outputTokens)} output tokens`}</title>
                        </rect>
                      );
                      offset += height;
                      return bar;
                    })}
                  </g>
                );
              })}
            </svg>
            <div className="mt-3 flex justify-between text-[0.65rem] text-faint">
              <span>{days[0]}</span>
              <span>{days[days.length - 1]}</span>
            </div>
            {(() => {
              // Session-count line over the same day axis: sessions active per day.
              const width = days.length * 44 + 20;
              const maxSessions = Math.max(
                1,
                ...days.map((day) => sessionsByDay.find((row) => row.day === day)?.sessions ?? 0),
              );
              const points = days
                .map((day, index) => {
                  const count = sessionsByDay.find((row) => row.day === day)?.sessions ?? 0;
                  return `${index * 44 + 24},${140 - (count / maxSessions) * 125}`;
                })
                .join(" ");
              return (
                <div className="mt-4 border-t border-line pt-3">
                  <p className="mb-1 text-[0.7rem] text-muted-foreground">
                    Sessions per day <span className="text-faint">(line, right scale)</span>
                  </p>
                  <svg
                    viewBox={`0 0 ${width} 145`}
                    role="img"
                    aria-label="Session count per day"
                    className="w-full"
                  >
                    <polyline
                      points={points}
                      fill="none"
                      stroke="var(--color-info)"
                      strokeWidth="2"
                      strokeDasharray="4 3"
                    />
                    {days.map((day, index) => {
                      const count = sessionsByDay.find((row) => row.day === day)?.sessions ?? 0;
                      return (
                        <circle
                          key={day}
                          cx={index * 44 + 24}
                          cy={140 - (count / maxSessions) * 125}
                          r="3"
                          fill="var(--color-info)"
                        >
                          <title>{`${day} · ${count} session${count === 1 ? "" : "s"}`}</title>
                        </circle>
                      );
                    })}
                  </svg>
                </div>
              );
            })()}
            <ul className="mt-3 flex flex-wrap gap-4 text-[0.7rem] text-muted-foreground">
              {models.map((model) => (
                <li key={`${model.provider}-${model.model}`} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block size-2.5 rounded-sm"
                    style={{ background: model.color }}
                  />
                  {model.model}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ModelShare({ perModel }: Readonly<{ perModel: readonly SessionUsageModelRow[] }>) {
  const max = Math.max(1, ...perModel.map((row) => row.outputTokens));
  return (
    <Card className="rounded-none border-line bg-panel/90">
      <CardHeader>
        <CardTitle>Model share</CardTitle>
        <CardDescription>Output tokens and requests by model.</CardDescription>
      </CardHeader>
      <CardContent>
        {perModel.length === 0 ? (
          <p className="text-sm text-muted-foreground">No models recorded yet.</p>
        ) : (
          <ul className="space-y-4">
            {perModel.map((row, index) => (
              <li key={`${row.provider}-${row.model}`}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[0.78rem]">
                  <span className="truncate font-mono">{row.model}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {compactNumber(row.outputTokens)} out · {compactNumber(row.requests)} req ·{" "}
                    {row.sessions} sess
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-sm bg-panel-hi">
                  <div
                    className="h-full rounded-sm"
                    style={{
                      width: `${(row.outputTokens / max) * 100}%`,
                      background: seriesColor(index),
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const sessionHelper = createColumnHelper<typeof sortableTableFeatures, SessionUsageRecord>();

const sessionColumns = sessionHelper.columns([
  sessionHelper.accessor("started", {
    id: "started",
    header: "Started",
    sortFn: "basic",
    cell: ({ row }) => (
      <span className="whitespace-nowrap font-mono text-[0.72rem] text-muted-foreground">
        {row.original.started.slice(0, 16).replace("T", " ")}
      </span>
    ),
  }),
  sessionHelper.accessor("title", {
    id: "session",
    header: "Session",
    sortFn: "basic",
    cell: ({ row }) => (
      <span className="block max-w-[340px]">
        <span className="block truncate">{row.original.title}</span>
        <span className="text-[0.65rem] text-faint">{row.original.taskType}</span>
      </span>
    ),
  }),
  sessionHelper.accessor("requests", {
    id: "requests",
    header: "Requests",
    sortFn: "basic",
    cell: ({ row }) => <span className="font-mono text-[0.78rem]">{row.original.requests}</span>,
  }),
  sessionHelper.accessor("outputTokens", {
    id: "outputTokens",
    header: "Output tokens",
    sortFn: "basic",
    cell: ({ row }) => (
      <span className="font-mono text-[0.78rem]">{compactNumber(row.original.outputTokens)}</span>
    ),
  }),
  sessionHelper.accessor("model", {
    id: "model",
    header: "Dominant model",
    sortFn: "basic",
    cell: ({ row }) => (
      <span className="font-mono text-[0.75rem]">{row.original.model || "—"}</span>
    ),
  }),
  sessionHelper.accessor("modelMs", {
    id: "modelTime",
    header: "Model time",
    sortFn: "basic",
    cell: ({ row }) => (
      <span className="font-mono text-[0.78rem]">{modelDuration(row.original.modelMs)}</span>
    ),
  }),
  sessionHelper.accessor((session) => session.edits + session.writes, {
    id: "touches",
    header: "Edits + writes",
    sortFn: "basic",
    cell: ({ row }) => (
      <span className="font-mono text-[0.78rem]">{row.original.edits + row.original.writes}</span>
    ),
  }),
]);

function LensToggle({
  lens,
  onLensChange,
}: Readonly<{
  lens: SessionsLens;
  onLensChange: (lens: SessionsLens) => void;
}>) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={lens}
      onValueChange={(value) => {
        if (value) onLensChange(value as SessionsLens);
      }}
      aria-label="Subagent lens"
    >
      {lensOptions.map(([value, label]) => (
        <ToggleGroupItem key={value} value={value}>
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function SessionsTable({
  sessions,
  lens,
  onLensChange,
  total,
}: Readonly<{
  sessions: readonly SessionUsageRecord[];
  lens: SessionsLens;
  onLensChange: (lens: SessionsLens) => void;
  total: number;
}>) {
  const table = useTable({
    features: sortableTableFeatures,
    columns: sessionColumns,
    data: sessions,
    getRowId: (session) => session.id,
  });

  return (
    <section className="content-section" id="sessions" aria-label="Session rollups">
      <div className="section-heading">
        <div>
          <p className="section-kicker">01 / session ledger</p>
          <h2>
            Where the tokens <em>went.</em>
          </h2>
        </div>
        <LensToggle lens={lens} onLensChange={onLensChange} />
      </div>
      <div className="result-line" aria-live="polite">
        <span>
          Showing <strong>{sessions.length}</strong> of {total} sessions
        </span>
        <span className="result-hint">
          Aggregate metadata only — read from the local agent database during sync.
        </span>
      </div>
      <div className="table-shell">
        <Table className="min-w-[860px] border-collapse">
          <caption className="sr-only">Agent session rollups</caption>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    scope="col"
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : undefined
                    }
                  >
                    <button
                      type="button"
                      className={cn("flex w-full items-center gap-1 text-left")}
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <span aria-hidden="true">
                        {header.column.getIsSorted() === "asc"
                          ? "↑"
                          : header.column.getIsSorted() === "desc"
                            ? "↓"
                            : ""}
                      </span>
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={sessionColumns.length}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  No sessions match this lens.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="hover:bg-acid/3">
                  {row.getAllCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className="border-b-0 px-[15px] py-3.5 align-top whitespace-normal"
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

// The Session handoffs lens (issue #65): the sessions page observing where
// work passed between sessions. It renders only what the session database
// attributes — recorded parent links as trees, skill tool calls collected at
// sync — and offers no way to act on a session: no buttons, no links.
function SessionHandoffsSection({
  forest,
  lens,
  onLensChange,
  total,
}: Readonly<{
  forest: SessionHandoffForest;
  lens: SessionsLens;
  onLensChange: (lens: SessionsLens) => void;
  total: number;
}>) {
  return (
    <section className="content-section" id="session-handoffs" aria-label="Session handoffs">
      <div className="section-heading">
        <div>
          <p className="section-kicker">01 / session handoffs</p>
          <h2>
            Where work <em>changed hands.</em>
          </h2>
        </div>
        <LensToggle lens={lens} onLensChange={onLensChange} />
      </div>
      <div className="result-line" aria-live="polite">
        <span>
          <strong>{forest.roots.length}</strong> session tree
          {forest.roots.length === 1 ? "" : "s"} from {total} sessions ·{" "}
          <strong>{forest.boundaries}</strong> handoff{" "}
          {forest.boundaries === 1 ? "boundary" : "boundaries"}
        </span>
        <span className="result-hint">
          Recorded parent links only — a /clear is visible just as a new session row, and compaction
          is not distinguishable.
        </span>
      </div>
      {forest.roots.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No sessions recorded.</p>
      ) : (
        <ul className="space-y-5">
          {forest.roots.map((node) => (
            <HandoffTree key={node.session.id} node={node} depth={0} />
          ))}
        </ul>
      )}
    </section>
  );
}

const skillCallCopy = (count: number) => `${count} skill call${count === 1 ? "" : "s"}`;

function HandoffTree({ node, depth }: Readonly<{ node: SessionHandoffNode; depth: number }>) {
  const { session } = node;
  return (
    <li
      className={cn("text-sm", depth > 0 && "border-l-2 border-line pl-4")}
      data-session-id={session.id}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {depth > 0 && (
          <span className="text-[0.65rem] tracking-[0.12em] text-faint uppercase">handoff ↳</span>
        )}
        <span className="font-medium">{session.title}</span>
        <span className="text-[0.65rem] text-faint">{session.taskType}</span>
        <span className="ml-auto font-mono text-[0.72rem] text-muted-foreground">
          {skillCallCopy(session.skillCalls)}
        </span>
      </div>
      {node.caveats.map((caveat) => (
        <p key={caveat.kind} className="mt-0.5 text-xs text-muted-foreground italic">
          {caveat.message}
        </p>
      ))}
      {node.children.length > 0 && (
        <ul className="mt-2 space-y-2">
          {node.children.map((child) => (
            <HandoffTree key={child.session.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
