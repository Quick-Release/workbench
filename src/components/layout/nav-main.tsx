import { Link, linkOptions, useRouterState } from "@tanstack/react-router";
import { Activity, ReceiptText, Sparkles, Wrench } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

// linkOptions keeps each entry typed against the registered route tree,
// including the required search defaults.
const overviewLink = linkOptions({
  to: "/",
  search: { q: "", status: "all", source: "all", stream: "all" },
});
const sessionsLink = linkOptions({
  to: "/sessions",
  search: { subagents: "all" },
});
const toolsLink = linkOptions({ to: "/tools" });
const skillsLink = linkOptions({ to: "/skills" });

type NavItem = { title: string; icon: typeof ReceiptText } & (
  | typeof overviewLink
  | typeof sessionsLink
  | typeof toolsLink
  | typeof skillsLink
);

export const navItems: NavItem[] = [
  { title: "Overview", icon: ReceiptText, ...overviewLink },
  { title: "Agent sessions", icon: Activity, ...sessionsLink },
  { title: "Tools", icon: Wrench, ...toolsLink },
  { title: "skills", icon: Sparkles, ...skillsLink },
];

export function NavMain({ items = navItems }: { items?: NavItem[] }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Workspace</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const { title, icon: Icon, ...link } = item;
            return (
              <SidebarMenuItem key={link.to}>
                <SidebarMenuButton asChild isActive={pathname === link.to} tooltip={title}>
                  <Link {...link}>
                    <Icon />
                    <span>{title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
