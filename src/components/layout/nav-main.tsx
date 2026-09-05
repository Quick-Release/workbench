import { Link, linkOptions, useRouterState } from "@tanstack/react-router";
import { Activity, Inbox, ReceiptText, Sparkles, Wrench } from "lucide-react";
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
const sessionsLink = linkOptions({
  to: "/sessions",
  search: { subagents: "all" },
});
const toolsLink = linkOptions({ to: "/tools" });
const skillsLink = linkOptions({ to: "/skills" });
const triageLink = linkOptions({ to: "/triage", search: {} });

type NavItem = { title: string; icon: typeof ReceiptText } & (
  | typeof overviewLink
  | typeof sessionsLink
  | typeof toolsLink
  | typeof skillsLink
  | typeof triageLink
);

// Spec #54's sidebar order: Overview, then the Workflow destination group,
// then Agent sessions and Tools.
const overviewItems: NavItem[] = [{ title: "Overview", icon: ReceiptText, ...overviewLink }];

const workflowItems: NavItem[] = [{ title: "Triage", icon: Inbox, ...triageLink }];

const closingItems: NavItem[] = [
  { title: "Agent sessions", icon: Activity, ...sessionsLink },
  { title: "Tools", icon: Wrench, ...toolsLink },
  { title: "skills", icon: Sparkles, ...skillsLink },
];

const NavMenu = ({ items }: { items: NavItem[] }) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
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
  );
};

export function NavMain({
  overview = overviewItems,
  workflow = workflowItems,
  closing = closingItems,
}: {
  overview?: NavItem[];
  workflow?: NavItem[];
  closing?: NavItem[];
}) {
  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarGroupContent>
          <NavMenu items={overview} />
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Workflow</SidebarGroupLabel>
        <SidebarGroupContent>
          <NavMenu items={workflow} />
        </SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupContent>
          <NavMenu items={closing} />
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
