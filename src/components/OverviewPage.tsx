import { useMemo } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { MetricCard } from "./MetricCard";
import { PlanTable } from "./PlanTable";
import { SpecPanel } from "./SpecPanel";
import { StatusBadge } from "./StatusBadge";
import { TicketTable } from "./TicketTable";
import {
  filterChanges,
  filterPlans,
  filterTickets,
  statusLabels,
  summaryFor,
  uniqueGroups,
} from "../lib/overview";
import type { OverviewData, OverviewSearch, TicketRecord } from "../types";

const sourceOptions = [
  ["all", "All records"],
  ["tickets", "Tickets"],
  ["plans", "Plans"],
  ["specs", "Specs"],
] as const;

const statusOptions = [
  ["all", "All statuses"],
  ["ready", statusLabels.ready],
  ["in-progress", statusLabels["in-progress"]],
  ["needs-development", statusLabels["needs-development"]],
  ["gated", statusLabels.gated],
  ["blocked", statusLabels.blocked],
  ["planned", statusLabels.planned],
  ["complete", statusLabels.complete],
  ["deferred", statusLabels.deferred],
] as const;

const calloutTopTone = {
  hot: "border-t-hot",
  good: "border-t-good",
  info: "border-t-info",
} as const;

const calloutLabelTone = {
  hot: "text-hot",
  good: "text-good",
  info: "text-amber",
} as const;

export function OverviewPage({
  data,
  search,
  onSearchChange,
  resetSearch,
}: Readonly<{
  data: OverviewData;
  search: OverviewSearch;
  onSearchChange: (next: Partial<OverviewSearch>) => void;
  resetSearch: () => void;
}>) {
  const summary = summaryFor(data);
  const projectName = data.meta.projectName || data.meta.repo || "Local project";
  const groups = uniqueGroups(data.tickets);
  const visibleTickets = useMemo(
    () => filterTickets(data.tickets, search.q, search.status, search.stream),
    [data.tickets, search.q, search.status, search.stream],
  );
  const visiblePlans = useMemo(
    () => filterPlans(data.plans, search.q, search.status, search.stream),
    [data.plans, search.q, search.status, search.stream],
  );
  const visibleChanges = useMemo(
    () => filterChanges(data.changes, search.q, search.status),
    [data.changes, search.q, search.status],
  );
  const showTickets = search.source === "all" || search.source === "tickets";
  const showPlans = search.source === "all" || search.source === "plans";
  const showSpecs = search.source === "all" || search.source === "specs";
  const readyTickets = data.tickets.filter((ticket) => ticket.status === "ready").slice(0, 3);
  const attentionTickets = data.tickets
    .filter((ticket) => ["gated", "blocked", "needs-development"].includes(ticket.status))
    .slice(0, 3);
  const snapshot = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(data.meta.snapshot));
  const activeFilter =
    search.q.length > 0 ||
    search.status !== "all" ||
    search.source !== "all" ||
    search.stream !== "all";

  return (
    <main className="app-shell" id="top">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="site-header">
        <div className="topline">
          <span className="eyebrow">{projectName.toLocaleUpperCase()} / WORKBENCH</span>
          <span className="snapshot">
            LOCAL SNAPSHOT <b>{snapshot}</b>
          </span>
        </div>
        <div className="brand-row">
          <a className="brand" href="#top" aria-label="Workbench home">
            <span className="brand-mark">W</span>
            <span>
              work<span>bench</span>
            </span>
          </a>
          <div className="header-actions">
            <span className="local-badge">
              <i /> read-only / local
            </span>
            <a href="/sessions">agent sessions</a>
            {data.meta.repositoryUrl && (
              <a href={data.meta.repositoryUrl} target="_blank" rel="noreferrer">
                repository ↗
              </a>
            )}
          </div>
        </div>
      </header>

      <nav className="section-nav" aria-label="Page sections">
        <a href="#tickets">
          Ticket ledger <b>{data.tickets.length}</b>
        </a>
        <a href="#plans">
          Plan corpus <b>{data.plans.length}</b>
        </a>
        <a href="#specs">
          OpenSpec <b>{data.changes.length}</b>
        </a>
        <a href="#sources">Sources + caveats</a>
      </nav>

      <section className="metrics" aria-label="Project summary">
        <MetricCard value={data.tickets.length} label="local ticket records" tone="info" />
        <MetricCard value={summary.open} label="not complete or deferred" tone="good" />
        <MetricCard value={summary.ready} label="ready-for-agent" tone="good" />
        <MetricCard value={summary["in-progress"]} label="in active motion" tone="info" />
        <MetricCard value={summary.attention} label="gates or development" tone="warn" />
        <MetricCard value={summary.complete} label="complete records" tone="neutral" />
      </section>

      <section className="callouts" aria-label="What matters now">
        <Callout tone="hot" label="01 / attention lane">
          <h2 className="mb-2.5 text-[1.08rem] font-bold leading-[1.18]">
            {attentionTickets.length > 0
              ? "Gates are visible, not implicit."
              : "No active gates found."}
          </h2>
          <p className="text-[0.82rem] leading-[1.48] text-muted-foreground">
            {attentionTickets.length > 0
              ? "These records need evidence, a decision, or material development before they can move."
              : "The current local corpus has no ticket classified as gated, blocked, or needing development."}
          </p>
          <MiniTicketList tickets={attentionTickets} />
        </Callout>
        <Callout tone="good" label="02 / clean frontier">
          <h2 className="mb-2.5 text-[1.08rem] font-bold leading-[1.18]">
            {readyTickets.length > 0
              ? "The ready-for-agent queue is ready to move."
              : "The ready-for-agent lane is empty."}
          </h2>
          <p className="text-[0.82rem] leading-[1.48] text-muted-foreground">
            {readyTickets.length > 0
              ? "ready-for-agent means the plan has made the work legible; it does not skip the required review steps."
              : "Use the plan corpus to find the next source that needs decomposition."}
          </p>
          <MiniTicketList tickets={readyTickets} />
        </Callout>
        <Callout tone="info" label="03 / source of truth">
          <h2 className="mb-2.5 text-[1.08rem] font-bold leading-[1.18]">
            Local documents stay authoritative.
          </h2>
          <p className="text-[0.82rem] leading-[1.48] text-muted-foreground">
            The app is a read-only projection. Status comes from the canonical ledger where one
            exists; otherwise it comes from the ticket&apos;s own plan file.
          </p>
          <a className="text-link" href="#sources">
            Read the source map ↘
          </a>
        </Callout>
      </section>

      <section aria-label="Overview filters">
        <Card className="mb-[76px] gap-0 rounded-none border-line-strong bg-panel/92 p-[22px] shadow-panel max-[780px]:mb-[55px]">
          <div className="control-heading">
            <div>
              <p className="section-kicker">Filter the workbench</p>
              <h2>
                Find the next <em>move.</em>
              </h2>
            </div>
            {activeFilter && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-none border-line-strong bg-transparent text-[0.75rem] font-normal text-muted-foreground shadow-none hover:border-acid hover:bg-transparent hover:text-acid"
                onClick={resetSearch}
              >
                Clear filters
              </Button>
            )}
          </div>
          <div className="filter-grid">
            <label className="search-control">
              <span>Search everything</span>
              <Input
                type="search"
                value={search.q}
                maxLength={120}
                placeholder="Try auth, production, a ticket ID, or a source path"
                className="h-[42px] rounded-none border-line-strong bg-field px-[11px] shadow-none placeholder:text-faint focus-visible:border-acid focus-visible:ring-acid/15"
                onChange={(event) => onSearchChange({ q: event.currentTarget.value })}
              />
            </label>
            <label>
              <span>Status lens</span>
              <NativeSelect
                value={search.status}
                onChange={(event) => {
                  const next = statusOptions.find(
                    ([value]) => value === event.currentTarget.value,
                  )?.[0];
                  if (next) onSearchChange({ status: next });
                }}
              >
                {statusOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              <span>Stream</span>
              <NativeSelect
                value={search.stream}
                onChange={(event) => onSearchChange({ stream: event.currentTarget.value })}
              >
                <option value="all">All streams</option>
                {groups.map((group) => (
                  <option key={group} value={group}>
                    {group}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
          <ToggleGroup
            type="single"
            spacing={8}
            value={search.source}
            aria-label="Source lens"
            className="source-tabs w-auto flex-wrap gap-[7px] rounded-none"
            onValueChange={(next) => {
              if (next) onSearchChange({ source: next as OverviewSearch["source"] });
            }}
          >
            {sourceOptions.map(([value, label]) => (
              <ToggleGroupItem
                key={value}
                value={value}
                variant="outline"
                /* Radix only applies aria-pressed on the client; SSR must carry it too. */
                aria-pressed={search.source === value}
                className="rounded-none border-line px-[11px] py-[7px] text-[0.74rem] font-normal text-muted-foreground shadow-none hover:border-acid hover:bg-acid/8 hover:text-acid data-[state=on]:border-acid data-[state=on]:bg-acid/8 data-[state=on]:text-acid"
              >
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Card>
      </section>

      {showTickets && <TicketTable tickets={visibleTickets} total={data.tickets.length} />}
      {showPlans && <PlanTable plans={visiblePlans} total={data.plans.length} />}
      {showSpecs && <SpecPanel changes={visibleChanges} total={data.changes.length} />}

      <footer className="site-footer" id="sources">
        <div>
          <p className="section-kicker">Source map</p>
          <h2>Useful context, without pretending it is live.</h2>
          <p>
            Snapshot <code>{data.meta.commit.slice(0, 8)}</code> on <code>{data.meta.branch}</code>.
            The projection is intentionally read-only and local. The browser never receives service
            credentials or mutates a remote task.
          </p>
        </div>
        <div className="source-list">
          {data.meta.sources.length > 0 ? (
            data.meta.sources.map((source) => <SourceLine key={source.path} {...source} />)
          ) : (
            <p className="muted-copy">No supported source documents found.</p>
          )}
          {data.meta.services.length > 0 && (
            <div className="service-statuses">
              <p className="section-kicker">Service sync</p>
              {data.meta.services.map((service) => (
                <ServiceStatusRow key={service.id} service={service} />
              ))}
            </div>
          )}
        </div>
      </footer>
    </main>
  );
}

function Callout({
  tone,
  label,
  children,
}: Readonly<{
  tone: "hot" | "good" | "info";
  label: string;
  children: ReactNode;
}>) {
  return (
    <Card
      className={cn(
        "min-h-[240px] gap-0 rounded-none border-line bg-panel/90 p-5 shadow-none",
        calloutTopTone[tone],
      )}
    >
      <span
        className={cn(
          "mb-[13px] block font-mono text-[0.66rem] tracking-[0.11em] uppercase",
          calloutLabelTone[tone],
        )}
      >
        {label}
      </span>
      {children}
    </Card>
  );
}

function MiniTicketList({ tickets }: Readonly<{ tickets: readonly TicketRecord[] }>) {
  if (tickets.length === 0) return null;
  return (
    <ul className="mini-ticket-list">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <a href={ticket.sourceUrl} target="_blank" rel="noreferrer">
            <code>{ticket.id}</code>
            <span>{ticket.title}</span>
          </a>
          <StatusBadge status={ticket.status} label={ticket.statusLabel} />
        </li>
      ))}
    </ul>
  );
}

function SourceLine({ label, path }: Readonly<{ label: string; path: string }>) {
  return (
    <div className="source-line">
      <span>{label}</span>
      <code>{path}</code>
    </div>
  );
}

function ServiceStatusRow({
  service,
}: Readonly<{ service: OverviewData["meta"]["services"][number] }>) {
  return (
    <div className={`service-status service-status-${service.status}`}>
      <span>
        <i aria-hidden="true" />
        {service.label}
      </span>
      <small>
        {service.itemCount > 0 ? `${service.itemCount} tasks · ` : ""}
        {service.message}
      </small>
    </div>
  );
}
