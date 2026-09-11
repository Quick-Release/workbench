import { Link, linkOptions, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  GitBranch,
  GitPullRequest,
  Inbox,
  LifeBuoy,
  MessagesSquare,
  ReceiptText,
  Rocket,
  ScrollText,
  Sparkles,
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
import { useWorkflowState } from "@/hooks/use-workflow-state";
import { openClientBugs } from "@/lib/client-priority";

// linkOptions keeps each entry typed against the registered route tree,
// including the required search defaults.
const overviewLink = linkOptions({
  to: "/",
  search: { q: "", status: "all", source: "all", stream: "all", view: "all", issue: undefined },
});
const clientTicketsLink = linkOptions({
  to: "/client-tickets",
  search: { lens: undefined, ownership: "all", waiting: false, q: "", issue: undefined },
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
const highlightsLink = linkOptions({ to: "/highlights" });
const transcriptsLink = linkOptions({ to: "/transcripts" });

type NavItem = { title: string; icon: typeof ReceiptText } & (
  | typeof overviewLink
  | typeof clientTicketsLink
  | typeof flowLink
  | typeof sessionsLink
  | typeof toolsLink
  | typeof triageLink
  | typeof blockersLink
  | typeof inFlightLink
  | typeof decisionsLink
  | typeof pullRequestsLink
  | typeof transcriptsLink
  | typeof highlightsLink
);

// Spec #54's sidebar order: Overview, then the Workflow destination group,
// then Agent sessions and Tools. Client tickets sits beside Overview (GH-136)
// — client attention is a workspace surface, not workflow navigation.
const overviewItems: NavItem[] = [
  { title: "Overview", icon: ReceiptText, ...overviewLink },
  { title: "Client tickets", icon: LifeBuoy, ...clientTicketsLink },
];

const workflowItems: NavItem[] = [
  { title: "Skill flow", icon: GitBranch, ...flowLink },
  { title: "Triage", icon: Inbox, ...triageLink },
  { title: "Blockers", icon: Waypoints, ...blockersLink },
  { title: "In flight", icon: Rocket, ...inFlightLink },
  { title: "Decisions", icon: ScrollText, ...decisionsLink },
  { title: "Pull requests", icon: GitPullRequest, ...pullRequestsLink },
  { title: "Highlights", icon: Sparkles, ...highlightsLink },
];

const closingItems: NavItem[] = [
  { title: "Agent sessions", icon: Activity, ...sessionsLink },
  { title: "Session capture", icon: MessagesSquare, ...transcriptsLink },
  { title: "Tools", icon: Wrench, ...toolsLink },
];

const NavMenu = ({ items, badge }: { items: NavItem[]; badge?: number }) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <SidebarMenu>
      {items.map((item) => {
        const { title, icon: Icon, ...link } = item;
        // The client-bug badge rides the Client tickets destination (GH-136):
        // a count, in text — visible when the sidebar is expanded, carried by
        // the global banner when it is collapsed.
        const showBadge = link.to === "/client-tickets" && typeof badge === "number" && badge > 0;
        return (
          <SidebarMenuItem key={link.to}>
            <SidebarMenuButton asChild isActive={pathname === link.to} tooltip={title}>
              <Link {...link}>
                <Icon />
                <span>{title}</span>
                {showBadge && (
                  <span
                    data-slot="nav-client-badge"
                    aria-label={`${badge} open client bugs`}
                    className="ml-auto rounded-full border border-amber/60 px-1.5 font-mono text-[0.65rem] text-amber"
                  >
                    {badge}
                  </span>
                )}
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
  const state = useWorkflowState();
  const bugCount = openClientBugs(state.workItems).length;
  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarGroupContent>
          <NavMenu items={overview} badge={bugCount} />
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
