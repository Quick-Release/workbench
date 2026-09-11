import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import type { OverviewData } from "@/types";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useWorkflowState } from "@/hooks/use-workflow-state";
import { openClientBugs } from "@/lib/client-priority";
import { AppSidebar } from "./app-sidebar";
import { SiteHeader } from "./site-header";

type AppShellProps = {
  meta: OverviewData["meta"];
  children: ReactNode;
};

// The client-bug banner (GH-136): persistent on every page while any open
// client bug exists — icon and text, never color alone, no dismiss-forever,
// no flashing. The gate behind it is enforced at the seam (ADR 0012); the
// banner explains the pause the Developer is seeing.
export function ClientBugBanner() {
  const state = useWorkflowState();
  const bugs = openClientBugs(state.workItems);
  if (bugs.length === 0) return null;
  return (
    <div
      role="status"
      data-slot="client-bug-banner"
      data-bugs={bugs.length}
      className="flex items-center gap-2 border-b border-amber/50 bg-amber/10 px-4 py-2 text-sm"
    >
      <ShieldAlert className="size-4 shrink-0 text-amber" aria-hidden="true" />
      <span className="font-medium">
        {bugs.length === 1 ? "1 open client bug" : `${bugs.length} open client bugs`} — new feature
        starts paused
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {bugs.map((bug) => bug.id).join(", ")}
      </span>
      <a
        href="/client-tickets?lens=bugs"
        className="ml-auto shrink-0 text-xs underline hover:text-acid"
      >
        Open client tickets
      </a>
    </div>
  );
}

export function AppShell({ meta, children }: AppShellProps) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <SiteHeader meta={meta} />
          <ClientBugBanner />
          <div className="flex flex-1 flex-col gap-10 p-(--content-padding) @container/main">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
