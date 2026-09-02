export const ticketStatuses = [
  "complete",
  "in-progress",
  "ready",
  "needs-development",
  "gated",
  "blocked",
  "planned",
  "deferred",
] as const;

export type TicketStatus = (typeof ticketStatuses)[number];

export type TicketRecord = {
  id: string;
  title: string;
  status: TicketStatus;
  statusLabel: string;
  statusDetail: string;
  group: string;
  lane: string;
  dependencies: string;
  summary: string;
  sourcePath: string;
  sourceUrl: string;
  kind: "ledger" | "plan-ticket";
  progress: { done: number; total: number };
};

export type PlanRecord = {
  id: string;
  title: string;
  status: TicketStatus;
  statusLabel: string;
  statusDetail: string;
  stream: string;
  ticketCount: number;
  openTicketCount: number;
  completeTicketCount: number;
  summary: string;
  sourcePath: string;
  sourceUrl: string;
};

export type SpecChangeRecord = {
  id: string;
  title: string;
  status: TicketStatus;
  statusLabel: string;
  summary: string;
  taskCount: number;
  completeTaskCount: number;
  sourcePath: string;
  sourceUrl: string;
};

export const sourceFilters = ["all", "tickets", "plans", "specs"] as const;

export type OverviewSearch = {
  q: string;
  status: TicketStatus | "all";
  source: (typeof sourceFilters)[number];
  stream: string;
};

export type OverviewSource = {
  label: string;
  path: string;
};

export type OverviewData = {
  meta: {
    projectName: string;
    snapshot: string;
    branch: string;
    commit: string;
    repo: string;
    repositoryUrl: string;
    docsRoot: string;
    sources: readonly OverviewSource[];
    ticketCount: number;
    planCount: number;
    changeCount: number;
  };
  tickets: readonly TicketRecord[];
  plans: readonly PlanRecord[];
  changes: readonly SpecChangeRecord[];
};
