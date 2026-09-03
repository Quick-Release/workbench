import type { OverviewData } from "@/types";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

type SiteHeaderProps = {
  meta: OverviewData["meta"];
};

export function SiteHeader({ meta }: SiteHeaderProps) {
  return (
    <header
      data-slot="header"
      className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/40 px-4 backdrop-blur-md"
    >
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <span className="truncate text-sm font-semibold">{meta.projectName}</span>
      <div className="ml-auto flex items-center gap-4 text-xs">
        <span className="text-muted-foreground">
          LOCAL SNAPSHOT <b className="text-foreground">{meta.snapshot}</b>
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
