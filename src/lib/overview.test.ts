import { describe, expect, it } from "vite-plus/test";

import {
  filterChanges,
  filterPlans,
  filterTickets,
  recordsForView,
  statusLabels,
  summaryFor,
  ticketCounts,
  uniqueGroups,
  viewCounts,
} from "./overview";
import type { OverviewData, SpecChangeRecord, TicketRecord } from "../types";

const data = {
  meta: {
    projectName: "banquinha",
    theme: {
      ink: "#f1f3e9",
      muted: "#a5b0a4",
      faint: "#718076",
      bg: "#101715",
      panel: "#17211d",
      "panel-hi": "#1d2b25",
      line: "#2b3a32",
      "line-strong": "#45574b",
      acid: "#c5e86c",
      "acid-dim": "#344525",
      amber: "#f2bf68",
      "amber-dim": "#48371e",
      coral: "#f18476",
      "coral-dim": "#4a2927",
      blue: "#8bc6d8",
      "blue-dim": "#203b43",
      "white-dim": "#d4d8cf",
    },
    services: [],
    snapshot: "2026-08-29T15:11:41+01:00",
    branch: "main",
    commit: "abc1234",
    repo: "Quick-Release/banquinha",
    repositoryUrl: "https://github.com/Quick-Release/banquinha",
    docsRoot: "docs",
    sources: [],
    ticketCount: 3,
    planCount: 1,
    changeCount: 1,
  },
  tickets: [
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
      id: "TKT-001",
      title: "Ready ticket",
      status: "ready",
      statusLabel: "ready-for-agent",
      statusDetail: "",
      group: "Ticket system",
      lane: "Core",
      dependencies: "—",
      summary: "Ticket",
      sourcePath: "docs/plans/ticket-system/tickets/TKT-001.md",
      sourceUrl: "https://github.com/Quick-Release/banquinha",
      kind: "plan-ticket",
      progress: { done: 0, total: 1 },
    },
    {
      id: "SEC-001",
      title: "Gate",
      status: "gated",
      statusLabel: "ready-for-human",
      statusDetail: "",
      group: "Security hardening",
      lane: "Review",
      dependencies: "—",
      summary: "Gate",
      sourcePath: "docs/plans/security-hardening/tickets/SEC-001.md",
      sourceUrl: "https://github.com/Quick-Release/banquinha",
      kind: "plan-ticket",
      progress: { done: 0, total: 1 },
    },
  ],
  plans: [
    {
      id: "TICKET-SYSTEM",
      title: "Ticket system",
      status: "in-progress",
      statusLabel: "in-progress",
      statusDetail: "Active implementation",
      stream: "Ticket system",
      ticketCount: 1,
      openTicketCount: 1,
      completeTicketCount: 0,
      summary: "A private ticket worker.",
      sourcePath: "docs/plans/ticket-system/README.md",
      sourceUrl: "https://github.com/Quick-Release/banquinha",
    },
  ],
  changes: [
    {
      id: "add-copilot",
      title: "Add copilot",
      status: "planned",
      statusLabel: "needs-triage",
      summary: "A staff copilot proposal.",
      taskCount: 2,
      completeTaskCount: 0,
      sourcePath: "openspec/changes/add-copilot/proposal.md",
      sourceUrl: "https://github.com/Quick-Release/banquinha",
    },
  ],
  sessions: {
    enabled: false,
    generatedAt: "2026-09-03T00:00:00.000Z",
    perDay: [],
    perModel: [],
    sessionsByDay: [],
    sessions: [],
  },
} satisfies OverviewData;

describe("workbench selectors", () => {
  it("uses the canonical engineering skill labels", () => {
    expect(statusLabels).toMatchObject({
      ready: "ready-for-agent",
      gated: "ready-for-human",
      planned: "needs-triage",
    });
  });

  it("counts tickets by normalized status and derives attention", () => {
    expect(ticketCounts(data.tickets)).toMatchObject({
      complete: 1,
      ready: 1,
      gated: 1,
    });
    expect(summaryFor(data)).toMatchObject({ open: 2, attention: 1 });
  });

  it("filters by a search term, status, and plan group", () => {
    expect(filterTickets(data.tickets, "ready-for-agent", "all", "all")).toHaveLength(1);
    expect(filterTickets(data.tickets, "", "gated", "all")[0]?.id).toBe("SEC-001");
    expect(filterTickets(data.tickets, "", "all", "Ticket system")).toHaveLength(1);
  });

  it("filters plan and proposal projections by their own status", () => {
    expect(filterPlans(data.plans, "worker", "all", "all")).toHaveLength(1);
    expect(filterPlans(data.plans, "", "complete", "all")).toHaveLength(0);
    expect(filterChanges(data.changes, "copilot", "planned")).toHaveLength(1);
    expect(filterChanges(data.changes, "copilot", "complete")).toHaveLength(0);
  });

  it("organizes the existing records into workflow views", () => {
    const externalTicket = {
      ...data.tickets[1],
      id: "GH-001",
      kind: "external",
      status: "planned",
      statusLabel: "needs-triage",
    } satisfies TicketRecord;
    const completedChange = {
      ...data.changes[0],
      id: "completed-change",
      status: "complete",
      statusLabel: "complete",
    } satisfies SpecChangeRecord;
    const viewData = {
      ...data,
      tickets: [...data.tickets, externalTicket],
      changes: [...data.changes, completedChange],
    } satisfies OverviewData;

    expect(recordsForView(viewData, "grilling").tickets.map((ticket) => ticket.id)).toEqual([
      "GH-001",
    ]);
    expect(recordsForView(viewData, "spec").plans).toHaveLength(1);
    expect(recordsForView(viewData, "tickets").changes.map((change) => change.id)).toEqual([
      "add-copilot",
    ]);
    expect(recordsForView(viewData, "implementation").tickets.map((ticket) => ticket.id)).toEqual([
      "TKT-001",
    ]);
    expect(viewCounts(viewData)).toEqual({
      all: 7,
      grilling: 1,
      spec: 1,
      tickets: 1,
      implementation: 1,
    });
  });

  it("returns sorted unique groups", () => {
    expect(uniqueGroups(data.tickets)).toEqual([
      "Dashboard",
      "Security hardening",
      "Ticket system",
    ]);
  });
});
