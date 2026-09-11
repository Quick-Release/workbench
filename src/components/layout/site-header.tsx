import type { OverviewData } from "@/types";
import { LifeBuoy } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useWorkflowState } from "@/hooks/use-workflow-state";
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

export function SiteHeader({ meta }: SiteHeaderProps) {
  const projectName = meta.projectName || meta.repo || "Local project";
  const snapshotLabel = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(meta.snapshot));
  const workflowState = useWorkflowState();
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
        <span className="text-muted-foreground">
          LOCAL SNAPSHOT <b className="text-foreground">{snapshotLabel}</b>
        </span>
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
