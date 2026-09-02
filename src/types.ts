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
  kind: "ledger" | "plan-ticket" | "external";
  externalSource?: string;
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

export type ExternalServiceStatus = {
  id: string;
  type: string;
  label: string;
  status: "connected" | "skipped" | "error";
  itemCount: number;
  message: string;
  sourcePath: string;
};

export type WorkbenchTheme = {
  ink: string;
  muted: string;
  faint: string;
  bg: string;
  panel: string;
  "panel-hi": string;
  line: string;
  "line-strong": string;
  acid: string;
  "acid-dim": string;
  amber: string;
  "amber-dim": string;
  coral: string;
  "coral-dim": string;
  blue: string;
  "blue-dim": string;
  "white-dim": string;
};

export type OverviewData = {
  meta: {
    projectName: string;
    theme: WorkbenchTheme;
    services: readonly ExternalServiceStatus[];
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
