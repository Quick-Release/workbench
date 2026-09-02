import { useMemo } from "react";
import type { ReactNode } from "react";

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
          <h2>
            {attentionTickets.length > 0
              ? "Gates are visible, not implicit."
              : "No active gates found."}
          </h2>
          <p>
            {attentionTickets.length > 0
              ? "These records need evidence, a decision, or material development before they can move."
              : "The current local corpus has no ticket classified as gated, blocked, or needing development."}
          </p>
          <MiniTicketList tickets={attentionTickets} />
        </Callout>
        <Callout tone="good" label="02 / clean frontier">
          <h2>
            {readyTickets.length > 0
              ? "The ready-for-agent queue is ready to move."
              : "The ready-for-agent lane is empty."}
          </h2>
          <p>
            {readyTickets.length > 0
              ? "ready-for-agent means the plan has made the work legible; it does not skip the required review steps."
              : "Use the plan corpus to find the next source that needs decomposition."}
          </p>
          <MiniTicketList tickets={readyTickets} />
        </Callout>
        <Callout tone="info" label="03 / source of truth">
          <h2>Local documents stay authoritative.</h2>
          <p>
            The app is a read-only projection. Status comes from the canonical ledger where one
            exists; otherwise it comes from the ticket&apos;s own plan file.
          </p>
          <a className="text-link" href="#sources">
            Read the source map ↘
          </a>
        </Callout>
      </section>

      <section className="control-panel" aria-label="Overview filters">
        <div className="control-heading">
          <div>
            <p className="section-kicker">Filter the workbench</p>
            <h2>
              Find the next <em>move.</em>
            </h2>
          </div>
          {activeFilter && (
            <button type="button" className="clear-button" onClick={resetSearch}>
              Clear filters
            </button>
          )}
        </div>
        <div className="filter-grid">
          <label className="search-control">
            <span>Search everything</span>
            <input
              type="search"
              value={search.q}
              maxLength={120}
              placeholder="Try auth, production, a ticket ID, or a source path"
              onChange={(event) => onSearchChange({ q: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>Status lens</span>
            <select
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
            </select>
          </label>
          <label>
            <span>Stream</span>
            <select
              value={search.stream}
              onChange={(event) => onSearchChange({ stream: event.currentTarget.value })}
            >
              <option value="all">All streams</option>
              {groups.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="source-tabs" role="group" aria-label="Source lens">
          {sourceOptions.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={search.source === value ? "source-tab active" : "source-tab"}
              aria-pressed={search.source === value}
              onClick={() => onSearchChange({ source: value })}
            >
              {label}
            </button>
          ))}
        </div>
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
            The projection is intentionally read-only and local; it does not authenticate to GitHub
            or mutate a remote issue.
          </p>
        </div>
        <div className="source-list">
          {data.meta.sources.length > 0 ? (
            data.meta.sources.map((source) => <SourceLine key={source.path} {...source} />)
          ) : (
            <p className="muted-copy">No supported source documents found.</p>
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
    <article className={`callout callout-${tone}`}>
      <span className="callout-label">{label}</span>
      {children}
    </article>
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
