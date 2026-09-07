import { Link, linkOptions, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  GitBranch,
  GitPullRequest,
  Inbox,
  MessagesSquare,
  ReceiptText,
  Rocket,
  ScrollText,
  Waypoints,
  Wrench,
} from "lucide-react";
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
  search: { q: "", status: "all", source: "all", stream: "all", view: "all", issue: undefined },
});
const sessionsLink = linkOptions({
  to: "/sessions",
  search: { subagents: "all" },
});
const toolsLink = linkOptions({ to: "/tools" });
const flowLink = linkOptions({
  to: "/flow",
  search: { favorites: false, skill: "" },
});
const triageLink = linkOptions({ to: "/triage", search: {} });
const blockersLink = linkOptions({ to: "/blockers", search: {} });
const inFlightLink = linkOptions({ to: "/in-flight" });
const decisionsLink = linkOptions({ to: "/decisions" });
const pullRequestsLink = linkOptions({ to: "/pull-requests" });
const transcriptsLink = linkOptions({ to: "/transcripts" });

type NavItem = { title: string; icon: typeof ReceiptText } & (
  | typeof overviewLink
  | typeof flowLink
  | typeof sessionsLink
  | typeof toolsLink
  | typeof triageLink
  | typeof blockersLink
  | typeof inFlightLink
  | typeof decisionsLink
  | typeof pullRequestsLink
  | typeof transcriptsLink
);

// Spec #54's sidebar order: Overview, then the Workflow destination group,
// then Agent sessions and Tools. The Workflow group grows one destination
// per landing ticket.
const overviewItems: NavItem[] = [{ title: "Overview", icon: ReceiptText, ...overviewLink }];

const workflowItems: NavItem[] = [
  { title: "Skill flow", icon: GitBranch, ...flowLink },
  { title: "Triage", icon: Inbox, ...triageLink },
  { title: "Blockers", icon: Waypoints, ...blockersLink },
  { title: "In flight", icon: Rocket, ...inFlightLink },
  { title: "Decisions", icon: ScrollText, ...decisionsLink },
  { title: "Pull requests", icon: GitPullRequest, ...pullRequestsLink },
];

const closingItems: NavItem[] = [
  { title: "Agent sessions", icon: Activity, ...sessionsLink },
  { title: "Session capture", icon: MessagesSquare, ...transcriptsLink },
  { title: "Tools", icon: Wrench, ...toolsLink },
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
