import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MetricCard } from "./MetricCard";
import { OverviewPage } from "./OverviewPage";
import { PlanTable } from "./PlanTable";
import { SessionsPage } from "./SessionsPage";
import { SkillsPage } from "./SkillsPage";
import { SpecPanel } from "./SpecPanel";
import { StatusBadge } from "./StatusBadge";
import { TicketTable } from "./TicketTable";
import type { OverviewData, PlanRecord, SpecChangeRecord, TicketRecord } from "../types";

const tickets = [
  {
    id: "BQ-001",
    title: "Freeze the contract",
    status: "complete",
    statusLabel: "complete",
    statusDetail: "",
    group: "Dashboard",
    lane: "Foundation",
    dependencies: "—",
    summary: "Contract",
    sourcePath: "docs/dashboard-plan/status.md",
    sourceUrl: "https://github.com/Quick-Release/banquinha",
    kind: "ledger",
    progress: { done: 1, total: 1 },
  },
  {
    id: "SEC-001",
    title: "Gate the release",
    status: "gated",
    statusLabel: "ready-for-human",
    statusDetail: "needs sign-off",
    group: "Security hardening",
    lane: "Review",
    dependencies: "BQ-001",
    summary: "Gate",
    sourcePath: "docs/plans/security-hardening/tickets/SEC-001.md",
    sourceUrl: "https://github.com/Quick-Release/banquinha",
    kind: "plan-ticket",
    progress: { done: 0, total: 2 },
  },
] satisfies TicketRecord[];

const plans = [
  {
    id: "TICKET-SYSTEM",
    title: "Ticket system",
    status: "in-progress",
    statusLabel: "in-progress",
    statusDetail: "Active implementation",
    stream: "Ticket system",
    ticketCount: 2,
    openTicketCount: 1,
    completeTicketCount: 1,
    summary: "A private ticket worker.",
    sourcePath: "docs/plans/ticket-system/README.md",
    sourceUrl: "https://github.com/Quick-Release/banquinha",
  },
] satisfies PlanRecord[];

const changes = [
  {
    id: "add-copilot",
    title: "Add copilot",
    status: "planned",
    statusLabel: "needs-triage",
    summary: "A staff copilot proposal.",
    taskCount: 4,
    completeTaskCount: 2,
    sourcePath: "openspec/changes/add-copilot/proposal.md",
    sourceUrl: "https://github.com/Quick-Release/banquinha",
  },
] satisfies SpecChangeRecord[];

const sessions = {
  enabled: true,
  generatedAt: "2026-09-03T00:00:00.000Z",
  perDay: [
    {
      day: "2026-09-01",
      provider: "builtin:zai-coding-plan",
      model: "GLM-5.3-Flash",
      requests: 4,
      sessions: 2,
      inputTokens: 1000,
      outputTokens: 500,
      cacheTokens: 100,
      modelMs: 5000,
    },
  ],
  perModel: [
    {
      provider: "builtin:zai-coding-plan",
      model: "GLM-5.3-Flash",
      requests: 4,
      sessions: 2,
      inputTokens: 1000,
      outputTokens: 500,
      cacheTokens: 100,
      modelMs: 5000,
    },
  ],
  sessionsByDay: [{ day: "2026-09-01", sessions: 2 }],
  sessions: [
    {
      id: "sess_root-1",
      taskType: "interactive",
      parent: "",
      title: "Build the thing",
      directory: "/tmp/checkout",
      started: "2026-09-01T10:00:00.000Z",
      requests: 3,
      inputTokens: 900,
      outputTokens: 400,
      modelMs: 4000,
      model: "GLM-5.3-Flash",
      edits: 2,
      writes: 1,
    },
    {
      id: "sess_child-1",
      taskType: "subagent_child",
      parent: "sess_root-1",
      title: "Explore side quest",
      directory: "/tmp/checkout",
      started: "2026-09-01T10:30:00.000Z",
      requests: 1,
      inputTokens: 100,
      outputTokens: 100,
      modelMs: 1000,
      model: "GLM-5.3-Flash",
      edits: 0,
      writes: 0,
    },
  ],
} satisfies OverviewData["sessions"];

const data = {
  meta: {
    projectName: "banquinha",
    theme: {} as OverviewData["meta"]["theme"],
    services: [],
    snapshot: "2026-08-29T15:11:41+01:00",
    branch: "main",
    commit: "abc1234def5678",
    repo: "Quick-Release/banquinha",
    repositoryUrl: "https://github.com/Quick-Release/banquinha",
    docsRoot: "docs",
    sources: [{ label: "Ledger", path: "docs/dashboard-plan/status.md" }],
    ticketCount: 2,
    planCount: 1,
    changeCount: 1,
  },
  tickets,
  plans,
  changes,
  workItems: [],
  maps: [],
  sessions,
} satisfies OverviewData;

const withoutComments = (html: string) => html.replace(/<!-- -->/g, "");

describe("rendered dashboard shell (shadcn rebuild)", () => {
  it("maps every ticket status to its badge tone", () => {
    const tones = [
      ["complete", "good"],
      ["ready", "ready"],
      ["gated", "warn"],
      ["needs-development", "warn"],
      ["blocked", "hot"],
      ["in-progress", "info"],
      ["deferred", "muted"],
      ["planned", "muted"],
    ] as const;
    for (const [status, tone] of tones) {
      const html = renderToString(<StatusBadge status={status} />);
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain('data-slot="badge"');
    }
  });

  it("renders the default status label with its status dot", () => {
    const html = renderToString(<StatusBadge status="ready" />);
    expect(html).toContain("ready-for-agent");
    expect(html).toContain("bg-current");
  });

  it("renders metric values with their tone and optional detail", () => {
    const html = renderToString(
      <MetricCard value={7} label="gates" tone="warn" detail="3 blocked" />,
    );
    expect(html).toContain(">7</strong>");
    expect(html).toContain("text-warn");
    expect(html).toContain("3 blocked");
  });

  it("renders ticket rows on the shadcn table shell with sort affordances", () => {
    const html = renderToString(<TicketTable tickets={tickets} total={5} />);
    expect(html).toContain('data-slot="table"');
    expect(html).toContain("BQ-001");
    expect(html).toContain("ready-for-human");
    expect((html.match(/↕/g) ?? []).length).toBe(5);
    expect(html).not.toContain("aria-sort");
    expect(html).toContain('aria-live="polite"');
    expect(withoutComments(html)).toContain("<strong>2</strong> of 5 ticket records");
  });

  it("shows the empty state when no tickets match the lens", () => {
    const html = renderToString(<TicketTable tickets={[]} total={5} />);
    expect(html).toContain("No tickets match this lens");
  });

  it("renders plan rows with ticket-load progress", () => {
    const html = renderToString(<PlanTable plans={plans} total={3} />);
    expect(html).toContain("TICKET-SYSTEM");
    expect(html).toContain('data-slot="progress"');
    expect(html).toContain("translateX(-50%)");
    expect(withoutComments(html)).toContain("1 open / 1 complete");
  });

  it("renders spec cards with completion progress and links the proposal", () => {
    const html = renderToString(<SpecPanel changes={changes} total={9} />);
    expect(html).toContain('data-slot="progress"');
    expect(html).toContain("translateX(-50%)");
    expect(withoutComments(html)).toContain("2/4 tasks checked");
    expect(html).toContain('rel="noreferrer"');
  });

  it("shows the spec empty state when nothing matches", () => {
    const html = renderToString(<SpecPanel changes={[]} total={9} />);
    expect(html).toContain("No change proposals match this lens.");
  });

  it("composes the full dashboard from shadcn primitives", () => {
    const html = renderToString(
      <OverviewPage
        data={data}
        search={{ q: "", status: "all", source: "all", stream: "all", view: "all" }}
        onSearchChange={() => {}}
        resetSearch={() => {}}
      />,
    );
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('type="search"');
    expect((html.match(/data-slot="native-select"/g) ?? []).length).toBe(2);
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(2);
    expect((html.match(/aria-pressed="false"/g) ?? []).length).toBe(7);
    expect(html).toContain("Ready for grilling");
    expect(html).toContain("Ready for spec");
    expect(html).toContain("Ready for tickets");
    expect(html).toContain("Ready for implementation");
    expect(html).toContain("border-t-hot");
    expect(html).toContain("border-t-good");
    expect(html).toContain("border-t-info");
    expect(html).toContain("text-good");
    expect(html).toContain("text-warn");
  });

  it("renders one workflow view at a time", () => {
    const html = renderToString(
      <OverviewPage
        data={data}
        search={{ q: "", status: "all", source: "all", stream: "all", view: "tickets" }}
        onSearchChange={() => {}}
        resetSearch={() => {}}
      />,
    );
    expect(html).toContain("Specs waiting for a");
    expect(html).not.toContain("Work that still needs a");
    expect(html).not.toContain("The plans behind the");
    expect(withoutComments(html)).toContain("<strong>1</strong> of 1 active change proposals");
  });

  it("renders the sessions page with charts and the session table", () => {
    const html = renderToString(
      <SessionsPage data={data} search={{ subagents: "all" }} onSearchChange={() => {}} />,
    );
    expect(html).toContain("Output tokens per day");
    expect(html).toContain("Model share");
    expect(html).toContain("Build the thing");
    expect(withoutComments(html)).toContain(">2</strong> of 2 sessions");
  });

  it("filters subagent sessions with the lens toggle", () => {
    const html = renderToString(
      <SessionsPage data={data} search={{ subagents: "subagents" }} onSearchChange={() => {}} />,
    );
    expect(html).not.toContain("Build the thing");
    expect(html).toContain("Explore side quest");
    expect(withoutComments(html)).toContain(">1</strong> of 2 sessions");
  });

  it("shows the disabled state when session tracking is off", () => {
    const html = renderToString(
      <SessionsPage
        data={{ ...data, sessions: { ...sessions, enabled: false } }}
        search={{ subagents: "all" }}
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("Session tracking is off");
    expect(html).not.toContain("Model share");
  });

  it("renders the favorite skills and local install command", () => {
    const html = renderToString(<SkillsPage />);
    expect(html).toContain("Matt Pocock Skills");
    expect(html).toContain("Grill with docs");
    expect(html).toContain("npx skills@latest add mattpocock/skills --all");
    expect(html).toContain("View source");
  });
});
