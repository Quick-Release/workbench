import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ClientCoverageNote, ClientTicketRow } from "@/components/ClientTicketList";
import { clientAttention } from "@/lib/client-priority";
import { deriveDisplayState } from "@/lib/display-state";
import { inFlightBuckets } from "@/lib/in-flight";
import {
  frontierStrip,
  recommendNextAction,
  type FrontierStrip as FrontierStripData,
  type Recommendation,
} from "@/lib/recommendation";
import { workItemIdNumberText } from "@/lib/work-item-id";

import type { OverviewData, WorkflowStatePayload } from "../types";

export function OverviewPage({
  data,
  state,
  mode,
  onOpenIssue,
  onSync,
  syncPending,
  syncMessage,
  syncWarnings,
}: Readonly<{
  data: OverviewData;
  state: WorkflowStatePayload;
  mode: "live" | "static";
  onOpenIssue: (issueId: string) => void;
  onSync: () => void;
  syncPending: boolean;
  syncMessage: string | null;
  syncWarnings: readonly string[];
}>) {
  const recommendation = useMemo(() => recommendNextAction(state), [state]);
  const strip = useMemo(() => frontierStrip(state), [state]);
  const inFlight = useMemo(() => inFlightBuckets(state.workItems), [state.workItems]);

  return (
    <>
      <section aria-label="Next action">
        <RecommendationHero recommendation={recommendation} onOpenIssue={onOpenIssue} />
      </section>

      <ClientAttentionSection state={state} onOpenIssue={onOpenIssue} />

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

      <footer className="site-footer" id="sources">
        <div>
          <p className="section-kicker">Source map</p>
          <h2>The snapshot behind the live surface.</h2>
          <p>
            Snapshot <code>{data.meta.commit.slice(0, 8)}</code> on <code>{data.meta.branch}</code>.
            The dashboard reads live state and starts actions through the localhost execution seam
            (ADR 0005); this snapshot is the static fallback when no dev server is running, and no
            service credential ever reaches the browser.
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

// The next-action hero (ticket #64): the recommendation's command-first
// primary line with its bucket reason line underneath (recommendation.ts's
// priority table). The item opens the shared detail panel; the command
// itself is copy bait for the terminal — no dashboard control starts a
// skill session.
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
                ? `#${workItemIdNumberText(recommendation.issueId)}`
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

// The Overview's Client attention section (GH-136, ADR 0012): every open
// client ticket — bugs first, feedback next, with ownership and the
// waiting/blocked reason — above ordinary work. Attention is not
// executability, so unassigned, untriaged, deferred, and waiting tickets all
// appear here; the section also renders when coverage is unknown or
// incomplete, because "no known client tickets" must never quietly pose as
// "no client tickets".
function ClientAttentionSection({
  state,
  onOpenIssue,
}: Readonly<{
  state: WorkflowStatePayload;
  onOpenIssue: (issueId: string) => void;
}>) {
  const { bugs, feedback } = clientAttention(state.workItems);
  const coverage = state.clientCoverage;
  if (bugs.length === 0 && feedback.length === 0 && (!coverage || coverage.complete)) return null;
  return (
    <section aria-label="Client attention">
      <Card
        data-slot="client-attention"
        className="gap-3 rounded-none border-amber/40 bg-panel/90 p-4 shadow-none"
      >
        <div className="flex flex-wrap items-baseline gap-x-3">
          <p className="section-kicker">Client attention — bugs first</p>
          <span className="text-xs text-muted-foreground" data-slot="client-attention-counts">
            {bugs.length} open {bugs.length === 1 ? "bug" : "bugs"} · {feedback.length} open{" "}
            {feedback.length === 1 ? "request" : "requests"}
          </span>
          <a href="/client-tickets" className="ml-auto text-xs underline hover:text-acid">
            All client tickets →
          </a>
        </div>
        <ClientCoverageNote coverage={coverage} />
        {bugs.length + feedback.length > 0 && (
          <ul data-slot="client-attention-list" className="flex flex-col">
            {[...bugs, ...feedback].map((record) => (
              <ClientTicketRow
                key={record.id}
                record={record}
                workItems={state.workItems}
                blockerEdges={state.blockerEdges}
                onOpenIssue={onOpenIssue}
              />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

// The repo-wide frontier strip (recommendation.ts's frontierStrip): each
// map's grabbable head in map order plus the unmapped bucket, every item
// opening the shared panel.
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
