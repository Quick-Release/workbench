import type { OverviewData } from "@/types";
import { LifeBuoy } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  useLiveRefreshStatus,
  useWorkflowMode,
  useWorkflowState,
} from "@/hooks/use-workflow-state";
import { useSyncTrigger } from "@/hooks/use-sync-trigger";
import { syncedAgo } from "@/lib/freshness";
import { clientAttention, openClientBugs } from "@/lib/client-priority";
import { recommendNextAction, type Recommendation } from "@/lib/recommendation";

type SiteHeaderProps = {
  meta: OverviewData["meta"];
};

// The global header chip (ticket #64, story 3): the recommendation's
// primary line on every page, informational until session spawning lands.
export function RecommendationChip({ recommendation }: { recommendation: Recommendation | null }) {
  if (!recommendation) return null;
  return (
    <a
      href="/"
      data-slot="recommendation-chip"
      data-informational={recommendation.command === null || undefined}
      title={recommendation.reason}
      className="inline-flex max-w-[26rem] items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-[0.67rem] text-foreground hover:border-acid"
    >
      <i className="size-1.5 rounded-full bg-acid" aria-hidden="true" />
      <span className="truncate font-mono">{recommendation.primary}</span>
      {recommendation.command === null && (
        <span className="tracking-widest text-muted-foreground uppercase">informational</span>
      )}
    </a>
  );
}

// The open-client counts (GH-136): a distinct bug count plus the
// feedback/request count, on every page regardless of local filters — a
// count in text, linked to the Client Tickets view. A plain anchor, like the
// header's other links: the header renders before the router in some views.
export function ClientCountChip({ bugs, requests }: { bugs: number; requests: number }) {
  const attention = bugs > 0;
  return (
    <a
      href="/client-tickets"
      data-slot="client-count-chip"
      data-attention={attention || undefined}
      aria-label={`${bugs} open client bugs, ${requests} open client requests`}
      title="Open client tickets"
      className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[0.67rem] ${
        attention ? "border-amber/60 text-amber" : "border-border text-muted-foreground"
      } hover:border-acid`}
    >
      <LifeBuoy className="size-3" aria-hidden="true" />
      <span className="font-mono">
        {bugs} {bugs === 1 ? "bug" : "bugs"} · {requests} {requests === 1 ? "request" : "requests"}
      </span>
    </a>
  );
}

// When the seam was last checked (GH-136): a fresh answer at the documented
// cadence reads as a plain timestamp; a failed check says so in words — the
// stale state is visible, never silently old.
export function LiveRefreshChip({
  status,
}: {
  status: { lastCheckedAt: string | null; error: string | null };
}) {
  if (!status.lastCheckedAt && !status.error) return null;
  const label = status.lastCheckedAt
    ? new Intl.DateTimeFormat("en-GB", { timeStyle: "medium" }).format(
        new Date(status.lastCheckedAt),
      )
    : "never";
  return (
    <span
      data-slot="live-refresh-status"
      data-error={status.error ? "1" : undefined}
      title={status.error ? `last refresh failed: ${status.error}` : `last checked ${label}`}
      className={`text-[0.67rem] tracking-widest uppercase ${
        status.error ? "text-amber" : "text-muted-foreground"
      }`}
    >
      {status.error ? "refresh failed — retrying" : "checked"}{" "}
      <b className={status.error ? "text-foreground" : "text-foreground"}>{label}</b>
    </span>
  );
}

// How fresh the served snapshot is (GH-145): "synced Ns ago" from the sync
// completion stamp, amber past the staleness threshold, honest "static
// snapshot" wording without a seam. A live read of an older snapshot — no
// stamp — renders nothing here; the LOCAL SNAPSHOT fallback shows instead.
export function FreshnessChip({
  syncedAt,
  mode,
}: {
  syncedAt: string | null;
  mode: "live" | "static";
}) {
  if (mode === "static")
    return (
      <span
        data-slot="freshness-chip"
        data-static="1"
        className="text-[0.67rem] tracking-widest text-muted-foreground uppercase"
      >
        static snapshot
      </span>
    );
  const ago = syncedAt ? syncedAgo(syncedAt, Date.now()) : null;
  if (!ago) return null;
  return (
    <span
      data-slot="freshness-chip"
      data-stale={ago.stale || undefined}
      title={`snapshot generated ${syncedAt}`}
      className={`text-[0.67rem] tracking-widest uppercase ${
        ago.stale ? "text-amber" : "text-muted-foreground"
      }`}
    >
      synced <b className="text-foreground">{ago.text}</b>
    </span>
  );
}

// The manual sync trigger beside the freshness chip (GH-145): the same
// wire-grammar sync the overview page offers, reachable from every page.
// Static mode hides it — the overview's sync section degrades to
// copy-the-command there.
export function SyncTriggerButton({ pending, onSync }: { pending: boolean; onSync: () => void }) {
  return (
    <button
      type="button"
      data-slot="header-sync-trigger"
      disabled={pending}
      onClick={onSync}
      className="rounded-md border border-border px-1.5 py-0.5 text-[0.67rem] tracking-widest text-muted-foreground uppercase hover:border-acid disabled:opacity-50"
    >
      {pending ? "Syncing…" : "Sync"}
    </button>
  );
}

export function SiteHeader({ meta }: SiteHeaderProps) {
  const projectName = meta.projectName || meta.repo || "Local project";
  const snapshotLabel = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(meta.snapshot));
  const workflowState = useWorkflowState();
  const mode = useWorkflowMode();
  const refresh = useLiveRefreshStatus();
  const { pending, sync } = useSyncTrigger();
  const recommendation = recommendNextAction(workflowState);
  const bugs = openClientBugs(workflowState.workItems);
  const feedback = clientAttention(workflowState.workItems).feedback;

  return (
    <header
      data-slot="header"
      className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/40 px-4 backdrop-blur-md"
    >
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <span className="truncate text-sm font-semibold">{projectName}</span>
      <div className="ml-auto flex items-center gap-4 text-xs">
        <ClientCountChip bugs={bugs.length} requests={feedback.length} />
        <RecommendationChip recommendation={recommendation} />
        <FreshnessChip syncedAt={workflowState.meta.syncedAt ?? null} mode={mode} />
        {mode === "live" && <SyncTriggerButton pending={pending} onSync={() => void sync()} />}
        {mode === "live" && !workflowState.meta.syncedAt && (
          <span className="text-muted-foreground">
            LOCAL SNAPSHOT <b className="text-foreground">{snapshotLabel}</b>
          </span>
        )}
        <LiveRefreshChip status={refresh} />
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-[0.67rem] tracking-widest text-muted-foreground uppercase">
          <i className="size-1.5 rounded-full bg-good" /> control surface / localhost
        </span>
        <a href="/sessions">agent sessions</a>
        {meta.repositoryUrl && (
          <a href={meta.repositoryUrl} target="_blank" rel="noreferrer">
            repository ↗
          </a>
        )}
      </div>
    </header>
  );
}
