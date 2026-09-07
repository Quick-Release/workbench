import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarProvider } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";
import type { OverviewData, WorkflowStatePayload, WorkItemRecord } from "../types";
import { OverviewPage } from "./OverviewPage";
import { SiteHeader } from "./layout/site-header";

const item = (number: number, overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id: `GH-${number}`,
  title: `Issue ${number}`,
  url: `https://github.com/Quick-Release/workbench/issues/${number}`,
  state: "open",
  assignees: [],
  phase: null,
  triageState: "unlabeled",
  deferred: false,
  category: null,
  kind: null,
  summary: "",
  ...overrides,
});

const state = (workItems: readonly WorkItemRecord[]): WorkflowStatePayload => ({
  workItems,
  maps: [
    {
      mapId: "GH-41",
      title: "Skills ecosystem",
      url: "https://github.com/Quick-Release/workbench/issues/41",
      ticketIds: ["GH-42", "GH-43"],
    },
  ],
  blockerEdges: [],
  decisions: [],
  artifacts: [],
  meta: { snapshot: "2026-09-05T12:00:00+01:00", repo: "Quick-Release/workbench" },
});

const data = {
  meta: {
    projectName: "workbench",
    theme: {
      ink: "#111",
      muted: "#444",
      faint: "#888",
      bg: "#fff",
      panel: "#faf",
      "panel-hi": "#fff",
      line: "#eee",
      "line-strong": "#ddd",
      acid: "#0f0",
      "acid-dim": "#0a0",
      amber: "#fa0",
      "amber-dim": "#a80",
      coral: "#f55",
      "coral-dim": "#c44",
      blue: "#06c",
      "blue-dim": "#049",
      "white-dim": "#eee",
    },
    services: [],
    snapshot: "2026-09-05T12:00:00+01:00",
    branch: "main",
    commit: "abc1234def5678",
    repo: "Quick-Release/workbench",
    repositoryUrl: "https://github.com/Quick-Release/workbench",
    docsRoot: "docs",
    sources: [],
  },
  workItems: [],
  maps: [],
  blockerEdges: [],
  decisions: [],
  artifacts: [],
  skills: [],
  skillInstalls: [],
  sessions: {
    enabled: false,
    generatedAt: "2026-09-05T12:00:00+01:00",
    perDay: [],
    perModel: [],
    sessionsByDay: [],
    sessions: [],
  },
} satisfies OverviewData;

const renderOverview = (
  workItems: readonly WorkItemRecord[],
  overrides: {
    mode?: "live" | "static";
    syncWarnings?: readonly string[];
    syncMessage?: string | null;
  } = {},
) =>
  renderToString(
    <OverviewPage
      data={data}
      state={state(workItems)}
      mode={overrides.mode ?? "live"}
      onOpenIssue={() => {}}
      onSync={() => {}}
      syncPending={false}
      syncMessage={overrides.syncMessage ?? null}
      syncWarnings={overrides.syncWarnings ?? []}
    />,
  );

describe("the next-action hero", () => {
  it("renders command-first copy with the reason line naming its bucket", () => {
    const html = renderOverview([
      item(34, { phase: "ticketed", triageState: "ready-for-agent", title: "Overview rebuild" }),
    ]);
    expect(html).toContain('data-slot="recommendation-hero"');
    expect(html).toContain("<code>/implement</code>");
    expect(html).toContain("#34");
    expect(html.match(/data-slot="recommendation-reason"[^>]*>([^<]*)/)?.[1]).toContain(
      "implementation frontier",
    );
  });

  it("opens the shared detail panel from the hero", () => {
    const html = renderOverview([item(34, { phase: "ticketed", triageState: "ready-for-agent" })]);
    expect(html).toContain('data-open-issue="GH-34"');
  });

  it("renders an all-clear line when nothing is recommended", () => {
    const html = renderOverview([]);
    expect(html).toContain('data-slot="recommendation-hero"');
    expect(html).toContain("all clear");
  });
});

describe("the repo-wide frontier strip", () => {
  it("renders maps in map order with their grabbable head plus the unmapped bucket", () => {
    const html = renderOverview([
      item(34, { phase: "ticketed", triageState: "ready-for-agent" }),
      item(42, { kind: "research" }),
      item(43, { kind: "grilling" }),
      item(41, { kind: "map", title: "Skills ecosystem" }),
    ]);
    // Only the map's head is listed — the first grabbable child in map order.
    expect(html).toContain('data-open-issue="GH-42"');
    expect(html).not.toContain('data-open-issue="GH-43"');
    expect(html).toContain('data-slot="strip-unmapped"');
    expect(html).toContain('data-open-issue="GH-34"');
  });

  it("renders a map with nothing grabbable without inventing a head", () => {
    const html = renderOverview([item(42, { kind: "research", assignees: ["vvaz"] })]);
    expect(html).toContain('data-slot="strip-map"');
    expect(html).toContain("nothing grabbable");
  });
});

describe("the overview in-flight rows", () => {
  it("surfaces resume-before-grab rows with the informational marking", () => {
    const html = renderOverview([
      item(58, { assignees: ["vvaz"], phase: "implementing" }),
      item(64, { assignees: ["vvaz"], triageState: "ready-for-agent" }),
    ]);
    expect(html).toContain('data-slot="overview-in-flight-row"');
    expect(html.match(/data-informational/g)?.length).toBe(1);
    expect(html).toContain("session spawning");
  });
});

describe("the sync trigger", () => {
  it("renders a live trigger button and surfaces the warnings channel", () => {
    const html = renderOverview([item(34)], {
      syncMessage: "Synced with 2 warnings.",
      syncWarnings: ["GH-41: cycle detected", "GH-64: no Work item line"],
    });
    expect(html).toContain('data-slot="sync-trigger"');
    expect(html).toContain("Synced with 2 warnings.");
    expect(html.match(/data-slot="sync-warning"/g)?.length).toBe(2);
    expect(html).toContain("cycle detected");
  });

  it("degrades the trigger to copy-the-command on a static build", () => {
    const html = renderOverview([item(34)], { mode: "static" });
    expect(html).toContain("pnpm sync");
    expect(html).not.toContain('data-slot="sync-trigger"');
  });
});

describe("the header chip", () => {
  it("renders in the site header on every page", () => {
    const html = renderToString(
      <TooltipProvider>
        <SidebarProvider>
          <SiteHeader meta={data.meta} />
        </SidebarProvider>
      </TooltipProvider>,
    );
    expect(html).toContain('data-slot="recommendation-chip"');
  });
});
