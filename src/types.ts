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

// The execution seam's workflow read payload (ticket #59): the synced records
// joined for live reads, with the snapshot stamp and repo as provenance.
// Later tickets extend it with decisions and artifacts.
export type WorkflowStateMeta = {
  snapshot: string;
  repo: string;
};

export type WorkflowStatePayload = {
  workItems: readonly WorkItemRecord[];
  maps: readonly TrackerMapRecord[];
  blockerEdges: readonly BlockerEdgeRecord[];
  meta: WorkflowStateMeta;
};

// The triage move action's contract: one work item, one target triage state.
// `wontfix` is a refusal, so it moves only with `confirm: true` — the
// dashboard's deliberate lens and confirmation.
export type TriageMoveRequest = {
  issueId: string;
  triageState: TriageState;
  confirm?: boolean;
};

export type TriageMoveResult = {
  message: string;
  issueId: string;
  triageState: TriageState;
  state: WorkflowStatePayload;
};

// ADR 0009: decisions collect at sync from exactly three sources — `adr`
// (docs/adr files), `resolution` (the closing comment on a closed decision
// ticket), and `spec` (one bundle per spec issue's Implementation-Decisions
// section) — never merged; the view groups them by work item. Artifacts are
// research notes only.
export const decisionSources = ["adr", "resolution", "spec"] as const;

export type DecisionSource = (typeof decisionSources)[number];

export const decisionStatuses = ["proposed", "accepted", "deprecated", "superseded"] as const;

export type DecisionStatus = (typeof decisionStatuses)[number];

export type DecisionRecord = {
  id: string;
  source: DecisionSource;
  workItemId: string | null;
  title: string;
  statement: string | null;
  status: DecisionStatus | null;
  supersedes: string | null;
  decidedAt: string | null;
  sourceRef: string;
};

export const artifactKinds = ["research-note"] as const;

export type ArtifactKind = (typeof artifactKinds)[number];

export type ArtifactRecord = {
  id: string;
  kind: ArtifactKind;
  path: string;
  title: string;
  workItemId: string | null;
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
  decisions: readonly DecisionRecord[];
  artifacts: readonly ArtifactRecord[];
  sessions: SessionUsage;
};
