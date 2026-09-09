export const serviceStatuses = ["connected", "skipped", "error"] as const;

export const skillFlowRoles = [
  "main-flow",
  "on-ramp",
  "standalone",
  "vocabulary",
  "primitive",
] as const;

export type SkillFlowRole = (typeof skillFlowRoles)[number];

export const skillFlowEdgeKinds = [
  "merges-onto",
  "delegates-to",
  "pairs-with",
  "runs-internally",
  "hands-off-to",
  "next-step",
] as const;

export type SkillFlowEdgeKind = (typeof skillFlowEdgeKinds)[number];

export type SkillRecord = {
  id: string;
  category: string;
  source: string;
};

export type SkillFlowEdge = {
  from: string;
  to: string;
  kind: SkillFlowEdgeKind;
};

export type SkillClassification = {
  role: SkillFlowRole | null;
  blurb: string;
  when: string;
};

export type SkillStatusRecord = {
  id: string;
  category: string;
  source: string;
  installed: boolean;
  description?: string;
};

export type SkillSourceStatus = {
  id: string;
  source: string;
  repositoryUrl: string;
  installCommand: string;
  installed: boolean;
  installedSkillCount: number;
  totalSkillCount: number;
};

export type SkillsStatus = {
  sources: readonly SkillSourceStatus[];
  skills: readonly SkillStatusRecord[];
  message?: string;
};

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
// Ticket #63 extends it with the decisions and artifacts the decisions view
// groups.
export type WorkflowStateMeta = {
  snapshot: string;
  repo: string;
};

export type WorkflowStatePayload = {
  workItems: readonly WorkItemRecord[];
  maps: readonly TrackerMapRecord[];
  blockerEdges: readonly BlockerEdgeRecord[];
  decisions: readonly DecisionRecord[];
  artifacts: readonly ArtifactRecord[];
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

// The issue actions' contracts (ticket #60, ADR 0005 phase-1): comment is
// additive and fires directly; edit overwrites the issue, so it moves only
// with `confirm: true` — the dashboard's deliberate beat before overwriting.
export type IssueEditRequest = {
  issueId: string;
  title?: string;
  body?: string;
  confirm?: boolean;
};

export type IssueEditResult = {
  message: string;
  issueId: string;
  state: WorkflowStatePayload;
};

export type IssueCommentRequest = {
  issueId: string;
  body: string;
};

export type IssueCommentResult = {
  message: string;
  issueId: string;
  commentUrl: string;
};

export type IssueCreateRequest = {
  title: string;
  body?: string;
};

export type IssueCreateResult = {
  message: string;
  issueId: string;
  state: WorkflowStatePayload;
};

// The sync trigger action's contract (ticket #64): a sync takes no fields,
// and the result surfaces the sync's warnings channel — cycles, dangling
// edges, unparsable statuses, missing linkage — plus the re-read state, so
// the UI summarizes data quality where sync is triggered.
export type SyncTriggerRequest = Record<string, never>;

export type SyncTriggerResult = {
  message: string;
  warnings: readonly string[];
  state: WorkflowStatePayload;
};

// The blocker-edge actions' contracts (ticket #61, ADR 0005 phase-1): adding
// a gate declares it with qualified ids; removal tears a gate off the
// tracker, so it moves only with `confirm: true` — the dashboard's
// destructive-action beat. Native blocked-by only speaks tracker issues.
export type EdgeAddRequest = {
  blockedId: string;
  blockerId: string;
};

export type EdgeRemoveRequest = {
  blockedId: string;
  blockerId: string;
  confirm?: boolean;
};

export type EdgeWriteResult = {
  message: string;
  blockedId: string;
  blockerId: string;
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

// The pull-request record family: open pull requests of the host repo,
// collected at sync beside the other tracker-backed families.
export type PullRequestRecord = {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  author: string;
  isDraft: boolean;
  body: string;
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
  skillCalls: number;
};

export type SessionUsage = {
  enabled: boolean;
  generatedAt: string;
  perDay: readonly SessionUsageDayRow[];
  perModel: readonly SessionUsageModelRow[];
  sessionsByDay: readonly SessionUsageSessionsByDay[];
  sessions: readonly SessionUsageRecord[];
};

export type CommitCandidate = {
  sha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  ticketRef: string;
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
  };
  workItems: readonly WorkItemRecord[];
  maps: readonly TrackerMapRecord[];
  blockerEdges: readonly BlockerEdgeRecord[];
  decisions: readonly DecisionRecord[];
  artifacts: readonly ArtifactRecord[];
  pullRequests: readonly PullRequestRecord[];
  skills: readonly SkillRecord[];
  skillInstalls: readonly string[];
  sessions: SessionUsage;
  highlights: readonly CommitCandidate[];
};

// The review engines (epic #20): what the review runner's health probe
// reports per engine (ticket #24). Each engine resolves to exactly one typed
// state; not-ready states carry the one-step remediation command, except
// probe_error, which carries the probe's own message. The
// vocabulary lives here; the health shapes are derived from the Effect Schema
// union in ./schema.ts so the compile-time and wire shapes cannot drift. The
// schema import is type-only — no runtime cycle, no schema code in the bundle.
import type { Schema } from "effect";
import type {
  ReviewCommentRequestSchema,
  ReviewCommentResultSchema,
  ReviewEngineHealthSchema,
  ReviewHealthSchema,
  ReviewHistoryEntrySchema,
  ReviewHistorySchema,
} from "./schema.ts";

// Every engine the runner can execute: the two review engines (a pull
// request is their target) and the issue-agent engine (an issue is). The
// review-only subset keeps its own name — the PR page's per-PR review
// buttons and the findings-comment action must never offer the agent.
export const reviewEngines = ["coderabbit", "zcode"] as const;

export const engines = [...reviewEngines, "opencode"] as const;

export type Engine = (typeof engines)[number];

export type ReviewEngine = (typeof reviewEngines)[number];

export type ReviewEngineHealth = Schema.Schema.Type<typeof ReviewEngineHealthSchema>;

export type ReviewHealth = Schema.Schema.Type<typeof ReviewHealthSchema>;

export type ReviewCommentRequest = Schema.Schema.Type<typeof ReviewCommentRequestSchema>;

export type ReviewCommentResult = Schema.Schema.Type<typeof ReviewCommentResultSchema>;

export type ReviewHistoryEntry = Schema.Schema.Type<typeof ReviewHistoryEntrySchema>;

export type ReviewHistory = Schema.Schema.Type<typeof ReviewHistorySchema>;
