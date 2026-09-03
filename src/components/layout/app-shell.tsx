import type { ReactNode } from "react";
import type { OverviewData } from "@/types";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "./app-sidebar";
import { SiteHeader } from "./site-header";

type AppShellProps = {
  meta: OverviewData["meta"];
  children: ReactNode;
};

export function AppShell({ meta, children }: AppShellProps) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <SiteHeader meta={meta} />
          <div className="flex flex-1 flex-col gap-10 p-(--content-padding) @container/main">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
