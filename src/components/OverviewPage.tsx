import { useMemo } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { deriveDisplayState } from "@/lib/display-state";
import { inFlightBuckets } from "@/lib/in-flight";
import {
  frontierStrip,
  recommendNextAction,
  type FrontierStrip as FrontierStripData,
  type Recommendation,
} from "@/lib/recommendation";
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
  overviewViewLabels,
  recordsForView,
  statusLabels,
  uniqueGroups,
  viewCounts,
} from "../lib/overview";
import { overviewViews, sourceFilters } from "../types";
import type { OverviewData, OverviewSearch, TicketRecord, WorkflowStatePayload } from "../types";

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

const workflowOptions = [
  { value: "all", description: "Everything in the snapshot" },
  { value: "grilling", description: "Untriaged external records" },
  { value: "spec", description: "Planning sources" },
  { value: "tickets", description: "Active change proposals" },
  { value: "implementation", description: "Ready-for-agent tickets" },
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
  state,
  mode,
  onOpenIssue,
  onSync,
  syncPending,
  syncMessage,
  syncWarnings,
}: Readonly<{
  data: OverviewData;
  search: OverviewSearch;
  onSearchChange: (next: Partial<OverviewSearch>) => void;
  resetSearch: () => void;
  state: WorkflowStatePayload;
  mode: "live" | "static";
  onOpenIssue: (issueId: string) => void;
  onSync: () => void;
  syncPending: boolean;
  syncMessage: string | null;
  syncWarnings: readonly string[];
}>) {
  const groups = uniqueGroups(data.tickets);
  const counts = viewCounts(data);
  const scopedData = useMemo(() => recordsForView(data, search.view), [data, search.view]);
  const visibleTickets = useMemo(
    () => filterTickets(scopedData.tickets, search.q, search.status, search.stream),
    [scopedData.tickets, search.q, search.status, search.stream],
  );
  const visiblePlans = useMemo(
    () => filterPlans(scopedData.plans, search.q, search.status, search.stream),
    [scopedData.plans, search.q, search.status, search.stream],
  );
  const visibleChanges = useMemo(
    () => filterChanges(scopedData.changes, search.q, search.status),
    [scopedData.changes, search.q, search.status],
  );
  const showTickets =
    (search.source === "all" || search.source === "tickets") &&
    ["all", "grilling", "implementation"].includes(search.view);
  const showPlans =
    (search.source === "all" || search.source === "plans") && ["all", "spec"].includes(search.view);
  const showSpecs =
    (search.source === "all" || search.source === "specs") &&
    ["all", "tickets"].includes(search.view);
  const readyTickets = data.tickets.filter((ticket) => ticket.status === "ready").slice(0, 3);
  const attentionTickets = data.tickets
    .filter((ticket) => ["gated", "blocked", "needs-development"].includes(ticket.status))
    .slice(0, 3);
  const activeFilter =
    search.q.length > 0 ||
    search.status !== "all" ||
    search.source !== "all" ||
    search.stream !== "all" ||
    search.view !== "all";

  const recommendation = useMemo(() => recommendNextAction(state), [state]);
  const strip = useMemo(() => frontierStrip(state), [state]);
  const inFlight = useMemo(() => inFlightBuckets(state.workItems), [state.workItems]);

  return (
    <>
      <section aria-label="Next action">
        <RecommendationHero recommendation={recommendation} onOpenIssue={onOpenIssue} />
      </section>

      <section aria-label="Repo-wide frontier">
        <FrontierStripSection strip={strip} onOpenIssue={onOpenIssue} />
      </section>

      <section aria-label="In-flight work">
        <OverviewInFlight buckets={inFlight} onOpenIssue={onOpenIssue} />
      </section>

      <section aria-label="Sync">
        <SyncSection
          mode={mode}
          pending={syncPending}
          message={syncMessage}
          warnings={syncWarnings}
          onSync={onSync}
        />
      </section>

      <section className="metrics" aria-label="Workflow summary">
        <MetricCard value={counts.grilling} label={overviewViewLabels.grilling} tone="hot" />
        <MetricCard value={counts.spec} label={overviewViewLabels.spec} tone="info" />
        <MetricCard value={counts.tickets} label={overviewViewLabels.tickets} tone="warn" />
        <MetricCard
          value={counts.implementation}
          label={overviewViewLabels.implementation}
          tone="good"
        />
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
              ? "The ready-for-agent lane is ready to move."
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
          <div className="workflow-view">
            <p className="section-kicker">Workflow views</p>
            <ToggleGroup
              type="single"
              spacing={8}
              value={search.view}
              aria-label="Workflow view"
              className="workflow-tabs w-full flex-wrap gap-[7px] rounded-none"
              onValueChange={(next) => {
                const view = overviewViews.find((candidate) => candidate === next);
                if (view) onSearchChange({ view, source: "all", stream: "all" });
              }}
            >
              {workflowOptions.map(({ value, description }) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  variant="outline"
                  aria-pressed={search.view === value}
                  className="workflow-tab rounded-none border-line px-[11px] py-[9px] text-left font-normal text-muted-foreground shadow-none hover:border-acid hover:bg-acid/8 hover:text-acid data-[state=on]:border-acid data-[state=on]:bg-acid/8 data-[state=on]:text-acid"
                >
                  <span className="workflow-tab-label">{overviewViewLabels[value]}</span>
                  <b className="workflow-tab-count">{counts[value]}</b>
                  <small className="workflow-tab-description">{description}</small>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
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
              const source = sourceFilters.find((candidate) => candidate === next);
              if (source) onSearchChange({ source, view: "all", stream: "all" });
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

      {showTickets && <TicketTable tickets={visibleTickets} total={scopedData.tickets.length} />}
      {showPlans && <PlanTable plans={visiblePlans} total={scopedData.plans.length} />}
      {showSpecs && <SpecPanel changes={visibleChanges} total={scopedData.changes.length} />}

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
    </>
  );
}

// The next-action hero (ticket #64, ADR 0010): the recommendation's
// command-first primary line with its bucket reason line underneath. The
// item opens the shared detail panel; the command itself is copy bait for
// the terminal — no dashboard control starts a skill session.
function RecommendationHero({
  recommendation,
  onOpenIssue,
}: Readonly<{
  recommendation: Recommendation | null;
  onOpenIssue: (issueId: string) => void;
}>) {
  return (
    <Card
      data-slot="recommendation-hero"
      className="gap-0 rounded-none border-line-strong bg-panel/92 p-[22px] shadow-panel"
    >
      <p className="section-kicker">Next action</p>
      {recommendation ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            data-open-issue={recommendation.issueId}
            onClick={() => onOpenIssue(recommendation.issueId)}
            className="flex w-fit flex-wrap items-baseline gap-x-2 text-left text-[1.35rem] font-bold leading-tight hover:text-acid"
          >
            {recommendation.command && <code>{recommendation.command}</code>}
            <span>
              {recommendation.command
                ? `#${recommendation.issueId.slice(3)}`
                : recommendation.primary}
            </span>
          </button>
          <p data-slot="recommendation-reason" className="text-[0.82rem] text-muted-foreground">
            {recommendation.reason}
          </p>
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing to act on right now — the board is all clear or waiting on someone else.
        </p>
      )}
    </Card>
  );
}

// The repo-wide frontier strip (ADR 0011): each map's grabbable head in map
// order plus the unmapped bucket, every item opening the shared panel.
function FrontierStripSection({
  strip,
  onOpenIssue,
}: Readonly<{
  strip: FrontierStripData;
  onOpenIssue: (issueId: string) => void;
}>) {
  const openIssueProps = (issueId: string) => ({
    "data-open-issue": issueId,
    onClick: () => onOpenIssue(issueId),
  });
  return (
    <div
      data-slot="frontier-strip"
      className="grid gap-4 lg:grid-cols-[repeat(auto-fit,minmax(260px,1fr))]"
    >
      {strip.maps.map(({ map, head }) => (
        <Card
          key={map.mapId}
          data-slot="strip-map"
          data-map={map.mapId}
          className="gap-2 rounded-none border-line bg-panel/90 p-4 shadow-none"
        >
          <p className="truncate text-xs font-semibold tracking-wide uppercase">{map.title}</p>
          {head ? (
            <button
              type="button"
              {...openIssueProps(head.id)}
              className="flex w-fit flex-col items-start gap-0.5 text-left text-sm hover:text-acid"
            >
              <span className="font-medium">{head.title}</span>
              <span className="font-mono text-xs text-muted-foreground">{head.id}</span>
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">nothing grabbable</p>
          )}
        </Card>
      ))}
      <Card
        data-slot="strip-unmapped"
        className="gap-2 rounded-none border-line bg-panel/90 p-4 shadow-none"
      >
        <p className="text-xs font-semibold tracking-wide uppercase">Unmapped open issues</p>
        {strip.unmapped.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {strip.unmapped.map((record) => (
              <li key={record.id}>
                <button
                  type="button"
                  {...openIssueProps(record.id)}
                  className="flex w-fit items-baseline gap-2 text-left text-sm hover:text-acid"
                >
                  <span className="font-mono text-xs text-muted-foreground">{record.id}</span>
                  <span className="font-medium">{record.title}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">nothing grabbable</p>
        )}
      </Card>
    </div>
  );
}

const IN_FLIGHT_SECTIONS = [
  { key: "reviewing", label: "Reviewing" },
  { key: "implementing", label: "Implementing" },
  { key: "notStarted", label: "Claimed — not started" },
] as const;

// The Overview's in-flight rows (stories 5 and 7): resume before grabbing,
// claimed-but-not-started marked informational until session spawning lands.
function OverviewInFlight({
  buckets,
  onOpenIssue,
}: Readonly<{
  buckets: ReturnType<typeof inFlightBuckets>;
  onOpenIssue: (issueId: string) => void;
}>) {
  const total = buckets.reviewing.length + buckets.implementing.length + buckets.notStarted.length;
  return (
    <Card className="gap-0 rounded-none border-line bg-panel/90 p-4 shadow-none">
      <p className="section-kicker">In flight — resume before grabbing</p>
      {total === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Nothing is in flight right now.</p>
      ) : (
        <ul className="mt-2 flex flex-col">
          {IN_FLIGHT_SECTIONS.map(({ key, label }) =>
            buckets[key].map((record) => {
              const display = deriveDisplayState(record, false);
              return (
                <li
                  key={record.id}
                  data-slot="overview-in-flight-row"
                  data-bucket={key}
                  data-informational={key === "notStarted" || undefined}
                  className="border-b py-2.5 last:border-b-0"
                >
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="section-kicker">{label}</span>
                    <button
                      type="button"
                      data-open-issue={record.id}
                      onClick={() => onOpenIssue(record.id)}
                      className="font-medium hover:text-acid"
                    >
                      {record.title}
                    </button>
                    <span className="font-mono text-xs text-muted-foreground">{record.id}</span>
                    {record.assignees.length > 0 && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {record.assignees.map((assignee) => `@${assignee}`).join(" ")}
                      </span>
                    )}
                  </p>
                  {key === "notStarted" && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      informational until session spawning lands
                    </p>
                  )}
                  {display.caveats.map((caveat) => (
                    <p key={caveat.kind} className="mt-0.5 text-xs text-muted-foreground italic">
                      {caveat.message}
                    </p>
                  ))}
                </li>
              );
            }),
          )}
        </ul>
      )}
    </Card>
  );
}

// The sync trigger with its warnings surface (ticket #64): cycles, dangling
// edges, unparsable statuses, and missing linkage summarized where sync is
// triggered; static builds degrade the trigger to copy-the-command.
function SyncSection({
  mode,
  pending,
  message,
  warnings,
  onSync,
}: Readonly<{
  mode: "live" | "static";
  pending: boolean;
  message: string | null;
  warnings: readonly string[];
  onSync: () => void;
}>) {
  return (
    <Card className="flex flex-col gap-2 rounded-none border-line bg-panel/90 p-4 shadow-none">
      <p className="section-kicker">Sync</p>
      {mode === "static" ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">No dev server — run the sync by hand:</p>
          <code className="block w-fit rounded bg-muted px-2 py-1 text-xs">pnpm sync</code>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            data-slot="sync-trigger"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={onSync}
          >
            {pending ? "Syncing…" : "Run sync"}
          </Button>
          {message && <span className="text-xs text-muted-foreground">{message}</span>}
        </div>
      )}
      {warnings.length > 0 && (
        <ul data-slot="sync-warnings" className="flex flex-col gap-1">
          {warnings.map((warning) => (
            <li key={warning} data-slot="sync-warning" className="text-xs text-amber">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </Card>
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
