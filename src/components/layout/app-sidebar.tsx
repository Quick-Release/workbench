import { Sidebar, SidebarContent, SidebarHeader } from "@/components/ui/sidebar";
import { NavMain } from "./nav-main";

export function AppSidebar() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            W
          </span>
          <span className="text-base font-semibold leading-none group-data-[collapsible=icon]:hidden">
            work<span className="text-primary">bench</span>
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain />
      </SidebarContent>
    </Sidebar>
  );
}
