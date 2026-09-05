import { Link, linkOptions, useRouterState } from "@tanstack/react-router";
import { Activity, GitBranch, ReceiptText, Wrench } from "lucide-react";
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
  search: { q: "", status: "all", source: "all", stream: "all", view: "all" },
});
const flowLink = linkOptions({
  to: "/flow",
  search: { favorites: false, skill: "" },
});
const sessionsLink = linkOptions({
  to: "/sessions",
  search: { subagents: "all" },
});
const toolsLink = linkOptions({ to: "/tools" });

type NavItem = { title: string; icon: typeof ReceiptText } & (
  | typeof overviewLink
  | typeof flowLink
  | typeof sessionsLink
  | typeof toolsLink
);

// Sidebar order per ADR 0011: Overview · Workflow · Agent sessions · Tools.
// The Workflow group grows one destination per landing ticket.
export const navGroups: Array<{ label: string; items: NavItem[] }> = [
  { label: "Overview", items: [{ title: "Overview", icon: ReceiptText, ...overviewLink }] },
  {
    label: "Workflow",
    items: [{ title: "Skill flow", icon: GitBranch, ...flowLink }],
  },
  {
    label: "Workspace",
    items: [
      { title: "Agent sessions", icon: Activity, ...sessionsLink },
      { title: "Tools", icon: Wrench, ...toolsLink },
    ],
  },
];

export function NavMain({ groups = navGroups }: { groups?: typeof navGroups }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
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
      ))}
    </>
  );
}
