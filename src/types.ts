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

export const ticketKinds = ["ledger", "plan-ticket", "external"] as const;

export const serviceStatuses = ["connected", "skipped", "error"] as const;

// ADR 0007 vocabulary: workflow phase (absent means pre-flow), triage state
// (the five tracker roles plus unlabeled), and decision-ticket kind.
export const workflowPhases = [
  "grilling",
  "prototyping",
  "specced",
  "ticketed",
  "implementing",
  "reviewing",
  "shipped",
] as const;

export type WorkflowPhase = (typeof workflowPhases)[number];

export const triageStates = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
  "unlabeled",
] as const;

export type TriageState = (typeof triageStates)[number];

export const wayfinderKinds = ["map", "research", "prototype", "grilling", "task"] as const;

export type WayfinderKind = (typeof wayfinderKinds)[number];

export const trackerCategories = ["bug", "enhancement"] as const;

export type TrackerCategory = (typeof trackerCategories)[number];

// ADR 0008: the tracker adapter's first-class records. A work item carries
// exactly what display state derives from (phase + triage + deferred +
// open/closed + assignees + kind); a map record is membership and order.
export type WorkItemRecord = {
  id: string;
  title: string;
  url: string;
  state: "open" | "closed";
  assignees: readonly string[];
  phase: WorkflowPhase | null;
  triageState: TriageState;
  deferred: boolean;
  category: TrackerCategory | null;
  kind: WayfinderKind | null;
  summary: string;
};

export type TrackerMapRecord = {
  mapId: string;
  title: string;
  url: string;
  ticketIds: readonly string[];
};

export type TicketRecord = {
  id: string;
  title: string;
  status: TicketStatus;
  statusLabel: string;
  statusDetail: string;
  group: string;
  lane: string;
  summary: string;
  sourcePath: string;
  sourceUrl: string;
  kind: (typeof ticketKinds)[number];
  externalSource?: string;
  progress: { done: number; total: number };
};

// ADR 0008: blocker edges are first-class records over namespaced work-item
// ids, gathered from GitHub native blocked-by and `Blocked by:` lines, one
// flat top-level list — cross-source edges have no single home ticket.
export const blockerEdgeSources = ["github-native", "blocked-by-line"] as const;

export type BlockerEdgeSource = (typeof blockerEdgeSources)[number];

export type BlockerEdgeRecord = {
  blockedId: string;
  blockerId: string;
  source: BlockerEdgeSource;
  sourceRef: string;
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

export const overviewViews = ["all", "grilling", "spec", "tickets", "implementation"] as const;

export type OverviewView = (typeof overviewViews)[number];

export type OverviewSearch = {
  q: string;
  status: TicketStatus | "all";
  source: (typeof sourceFilters)[number];
  stream: string;
  view: OverviewView;
};

export type OverviewSource = {
  label: string;
  path: string;
};

export type ExternalServiceStatus = {
  id: string;
  type: string;
  label: string;
  status: (typeof serviceStatuses)[number];
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

export type SessionUsageDayRow = {
  day: string;
  provider: string;
  model: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  modelMs: number;
};

export type SessionUsageModelRow = {
  provider: string;
  model: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  modelMs: number;
};

export type SessionUsageSessionsByDay = {
  day: string;
  sessions: number;
};

export type SessionUsageRecord = {
  id: string;
  taskType: string;
  parent: string;
  title: string;
  directory: string;
  started: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  modelMs: number;
  model: string;
  edits: number;
  writes: number;
};

export type SessionUsage = {
  enabled: boolean;
  generatedAt: string;
  perDay: readonly SessionUsageDayRow[];
  perModel: readonly SessionUsageModelRow[];
  sessionsByDay: readonly SessionUsageSessionsByDay[];
  sessions: readonly SessionUsageRecord[];
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
  workItems: readonly WorkItemRecord[];
  maps: readonly TrackerMapRecord[];
  blockerEdges: readonly BlockerEdgeRecord[];
  sessions: SessionUsage;
};
