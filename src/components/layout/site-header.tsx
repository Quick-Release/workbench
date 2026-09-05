import type { OverviewData } from "@/types";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useWorkflowState } from "@/hooks/use-workflow-state";
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

export function SiteHeader({ meta }: SiteHeaderProps) {
  const projectName = meta.projectName || meta.repo || "Local project";
  const snapshotLabel = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(meta.snapshot));
  const workflowState = useWorkflowState();
  const recommendation = recommendNextAction(workflowState);

  return (
    <header
      data-slot="header"
      className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/40 px-4 backdrop-blur-md"
    >
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <span className="truncate text-sm font-semibold">{projectName}</span>
      <div className="ml-auto flex items-center gap-4 text-xs">
        <RecommendationChip recommendation={recommendation} />
        <span className="text-muted-foreground">
          LOCAL SNAPSHOT <b className="text-foreground">{snapshotLabel}</b>
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-[0.67rem] tracking-widest text-muted-foreground uppercase">
          <i className="size-1.5 rounded-full bg-good" /> read-only / local
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
