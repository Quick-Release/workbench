import { Schema } from "effect";

import type {
  OverviewData,
  ReviewCommentRequest,
  ReviewCommentResult,
  ReviewHealth,
  ReviewHistory,
  SkillClassification,
  SkillFlowEdge,
  SkillsStatus,
  SyncTriggerRequest,
} from "./types.ts";
import {
  artifactKinds,
  blockerEdgeSources,
  decisionSources,
  decisionStatuses,
  engines,
  reviewEngines,
  serviceStatuses,
  skillFlowEdgeKinds,
  skillFlowRoles,
  trackerCategories,
  triageStates,
  wayfinderKinds,
  workflowPhases,
} from "./types.ts";
export const ServiceStatusSchema = Schema.Literals(serviceStatuses);

export const SkillFlowRoleSchema = Schema.NullOr(Schema.Literals(skillFlowRoles));

export const SkillFlowEdgeKindSchema = Schema.Literals(skillFlowEdgeKinds);

export const SkillRecordSchema = Schema.Struct({
  id: Schema.String,
  category: Schema.String,
  source: Schema.String,
});

export const SkillFlowEdgeSchema = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  kind: SkillFlowEdgeKindSchema,
});

export const SkillClassificationSchema = Schema.Struct({
  role: SkillFlowRoleSchema,
  blurb: Schema.String,
  when: Schema.String,
});

export const SkillStatusRecordSchema = Schema.Struct({
  id: Schema.String,
  category: Schema.String,
  source: Schema.String,
  installed: Schema.Boolean,
  description: Schema.optional(Schema.String),
});

export const SkillSourceStatusSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  repositoryUrl: Schema.String,
  installCommand: Schema.String,
  installed: Schema.Boolean,
  installedSkillCount: Schema.Number,
  totalSkillCount: Schema.Number,
});

export const SkillsStatusSchema = Schema.Struct({
  sources: Schema.Array(SkillSourceStatusSchema),
  skills: Schema.Array(SkillStatusRecordSchema),
  message: Schema.optional(Schema.String),
});

export const WorkflowPhaseSchema = Schema.NullOr(Schema.Literals(workflowPhases));

export const TriageStateSchema = Schema.Literals(triageStates);

export const WayfinderKindSchema = Schema.NullOr(Schema.Literals(wayfinderKinds));

export const TrackerCategorySchema = Schema.NullOr(Schema.Literals(trackerCategories));

export const BlockerEdgeSourceSchema = Schema.Literals(blockerEdgeSources);

// ADR 0008: `{blockedId, blockerId, source, sourceRef}` — the issue URL or
// ticket-file path the edge was declared at, as provenance.
export const BlockerEdgeRecordSchema = Schema.Struct({
  blockedId: Schema.String,
  blockerId: Schema.String,
  source: BlockerEdgeSourceSchema,
  sourceRef: Schema.String,
});

export const WorkItemRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  assignees: Schema.Array(Schema.String),
  phase: WorkflowPhaseSchema,
  triageState: TriageStateSchema,
  deferred: Schema.Boolean,
  category: TrackerCategorySchema,
  kind: WayfinderKindSchema,
  summary: Schema.String,
});

// ADR 0009: one decision record per source conclusion — `statement` carries
// the full resolution comment for resolution records and is null elsewhere;
// `status`/`supersedes`/`decidedAt` are null wherever their source doesn't
// declare them.
export const DecisionSourceSchema = Schema.Literals(decisionSources);

export const DecisionStatusSchema = Schema.NullOr(Schema.Literals(decisionStatuses));

export const DecisionRecordSchema = Schema.Struct({
  id: Schema.String,
  source: DecisionSourceSchema,
  workItemId: Schema.NullOr(Schema.String),
  title: Schema.String,
  statement: Schema.NullOr(Schema.String),
  status: DecisionStatusSchema,
  supersedes: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(Schema.String),
  sourceRef: Schema.String,
});

export const ArtifactKindSchema = Schema.Literals(artifactKinds);

export const ArtifactRecordSchema = Schema.Struct({
  id: Schema.String,
  kind: ArtifactKindSchema,
  path: Schema.String,
  title: Schema.String,
  workItemId: Schema.NullOr(Schema.String),
});

export const TrackerMapRecordSchema = Schema.Struct({
  mapId: Schema.String,
  title: Schema.String,
  url: Schema.String,
  ticketIds: Schema.Array(Schema.String),
});

// The pull-request record family (ticket #79): open pull requests of the
// host repo, collected at sync and schema-validated like every family.
export const PullRequestRecordSchema = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  head: Schema.String,
  base: Schema.String,
  author: Schema.String,
  isDraft: Schema.Boolean,
  body: Schema.String,
});

// The execution seam's contracts (ticket #59): the workflow read payload and
// the triage move action, validated in both directions at the seam boundary.
export const WorkflowStateMetaSchema = Schema.Struct({
  snapshot: Schema.String,
  repo: Schema.String,
});

export const WorkflowStatePayloadSchema = Schema.Struct({
  workItems: Schema.Array(WorkItemRecordSchema),
  maps: Schema.Array(TrackerMapRecordSchema),
  blockerEdges: Schema.Array(BlockerEdgeRecordSchema),
  decisions: Schema.Array(DecisionRecordSchema),
  artifacts: Schema.Array(ArtifactRecordSchema),
  meta: WorkflowStateMetaSchema,
});

export const TriageMoveRequestSchema = Schema.Struct({
  issueId: Schema.String,
  triageState: TriageStateSchema,
  confirm: Schema.optional(Schema.Boolean),
});

export const TriageMoveResultSchema = Schema.Struct({
  message: Schema.String,
  issueId: Schema.String,
  triageState: TriageStateSchema,
  state: WorkflowStatePayloadSchema,
});

// The issue actions (ticket #60): comment and create are additive, edit
// overwrites — its `confirm` flag is the deliberate beat, enforced at the
// seam, before a write replaces the issue's title or body.
export const IssueEditRequestSchema = Schema.Struct({
  issueId: Schema.String,
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  confirm: Schema.optional(Schema.Boolean),
});

export const IssueEditResultSchema = Schema.Struct({
  message: Schema.String,
  issueId: Schema.String,
  state: WorkflowStatePayloadSchema,
});

export const IssueCommentRequestSchema = Schema.Struct({
  issueId: Schema.String,
  body: Schema.String,
});

export const IssueCommentResultSchema = Schema.Struct({
  message: Schema.String,
  issueId: Schema.String,
  commentUrl: Schema.String,
});

export const IssueCreateRequestSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.optional(Schema.String),
});

export const IssueCreateResultSchema = Schema.Struct({
  message: Schema.String,
  issueId: Schema.String,
  state: WorkflowStatePayloadSchema,
});

// The sync trigger (ticket #64): no request fields; the result carries the
// warnings channel and the re-read state.
export const SyncTriggerRequestSchema = Schema.Struct({});

export const SyncTriggerResultSchema = Schema.Struct({
  message: Schema.String,
  warnings: Schema.Array(Schema.String),
  state: WorkflowStatePayloadSchema,
});

// The AI draft seam (ticket #37): the client sends only a PR number; the
// endpoint answers with the structured draft. The model's own output schema
// is Zod (TanStack AI's structured-output contract, per spec #34) — this is
// the seam boundary both its HTTP sides pass through.
export const AiDraftRequestSchema = Schema.Struct({
  pr: Schema.Number,
});

export const AiDraftResultSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
});

export const AiHealthSchema = Schema.Struct({
  configured: Schema.Boolean,
});

// The review seam's health response (epic #20, ticket #24): per-engine
// availability as one typed state each, carrying the engine's version when
// the binary was found. Not-ready states carry the one-step remediation
// command, except probe_error, which carries the probe's own message. The
// setup flavors are engine-specific: CodeRabbit needs an Agentic API key,
// zcode a model provider, and the issue agent (issue #40) a reachable
// Ollama server with the default model pulled — plus, when ready, the
// pulled-model list the panel's picker offers and the context-length
// warning that keeps a silent truncation from reading as a dumb model.
export const ReviewEngineHealthSchema = Schema.Union([
  Schema.Struct({
    engine: Schema.Literals(engines),
    state: Schema.Literal("ready"),
    version: Schema.String,
  }),
  Schema.Struct({
    engine: Schema.Literals(engines),
    state: Schema.Literal("binary_missing"),
    remediation: Schema.String,
  }),
  Schema.Struct({
    engine: Schema.Literal("coderabbit"),
    state: Schema.Literal("auth_missing"),
    version: Schema.String,
    remediation: Schema.String,
  }),
  Schema.Struct({
    engine: Schema.Literal("zcode"),
    state: Schema.Literal("provider_missing"),
    version: Schema.String,
    remediation: Schema.String,
  }),
  Schema.Struct({
    engine: Schema.Literal("opencode"),
    state: Schema.Literal("ollama_unreachable"),
    version: Schema.String,
    remediation: Schema.String,
  }),
  Schema.Struct({
    engine: Schema.Literal("opencode"),
    state: Schema.Literal("model_missing"),
    version: Schema.String,
    model: Schema.String,
    models: Schema.Array(Schema.String),
    remediation: Schema.String,
  }),
  Schema.Struct({
    engine: Schema.Literal("opencode"),
    state: Schema.Literal("ready"),
    version: Schema.String,
    models: Schema.Array(Schema.String),
    defaultModel: Schema.String,
    warning: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    engine: Schema.Literals(engines),
    state: Schema.Literal("probe_error"),
    message: Schema.String,
  }),
]);

export const ReviewHealthSchema = Schema.Struct({
  engines: Schema.Array(ReviewEngineHealthSchema),
});

// The review findings' post-as-comment action (ticket #25): the page sends
// the enumerated target and the findings it already holds — no command text
// ever crosses the seam; the comment body is composed server-side with the
// engine and PR attribution.
export const ReviewCommentRequestSchema = Schema.Struct({
  engine: Schema.Literals(reviewEngines),
  pr: Schema.Number,
  findings: Schema.String,
});

export const ReviewCommentResultSchema = Schema.Struct({
  message: Schema.String,
  engine: Schema.Literals(reviewEngines),
  pr: Schema.Number,
  commentUrl: Schema.String,
});

// The blocker-edge actions (ticket #61): an add declares a gate with
// qualified ids; a removal is destructive — its `confirm` flag is the
// deliberate beat, enforced at the seam, before a gate is torn off the
// tracker.
export const EdgeAddRequestSchema = Schema.Struct({
  blockedId: Schema.String,
  blockerId: Schema.String,
});

export const EdgeRemoveRequestSchema = Schema.Struct({
  blockedId: Schema.String,
  blockerId: Schema.String,
  confirm: Schema.optional(Schema.Boolean),
});

export const EdgeWriteResultSchema = Schema.Struct({
  message: Schema.String,
  blockedId: Schema.String,
  blockerId: Schema.String,
  state: WorkflowStatePayloadSchema,
});

export const WorkbenchThemeSchema = Schema.Struct({
  ink: Schema.String,
  muted: Schema.String,
  faint: Schema.String,
  bg: Schema.String,
  panel: Schema.String,
  "panel-hi": Schema.String,
  line: Schema.String,
  "line-strong": Schema.String,
  acid: Schema.String,
  "acid-dim": Schema.String,
  amber: Schema.String,
  "amber-dim": Schema.String,
  coral: Schema.String,
  "coral-dim": Schema.String,
  blue: Schema.String,
  "blue-dim": Schema.String,
  "white-dim": Schema.String,
});

export const ExternalServiceStatusSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  label: Schema.String,
  status: ServiceStatusSchema,
  itemCount: Schema.Number,
  message: Schema.String,
  sourcePath: Schema.String,
});

export const OverviewSourceSchema = Schema.Struct({
  label: Schema.String,
  path: Schema.String,
});

export const SessionUsageDayRowSchema = Schema.Struct({
  day: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  requests: Schema.Number,
  sessions: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheTokens: Schema.Number,
  modelMs: Schema.Number,
});

export const SessionUsageModelRowSchema = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  requests: Schema.Number,
  sessions: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheTokens: Schema.Number,
  modelMs: Schema.Number,
});

export const SessionUsageRecordSchema = Schema.Struct({
  id: Schema.String,
  taskType: Schema.String,
  parent: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  started: Schema.String,
  requests: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  modelMs: Schema.Number,
  model: Schema.String,
  edits: Schema.Number,
  writes: Schema.Number,
  skillCalls: Schema.Number,
});

export const SessionUsageSessionsByDaySchema = Schema.Struct({
  day: Schema.String,
  sessions: Schema.Number,
});

export const SessionUsageSchema = Schema.Struct({
  enabled: Schema.Boolean,
  generatedAt: Schema.String,
  perDay: Schema.Array(SessionUsageDayRowSchema),
  perModel: Schema.Array(SessionUsageModelRowSchema),
  sessionsByDay: Schema.Array(SessionUsageSessionsByDaySchema),
  sessions: Schema.Array(SessionUsageRecordSchema),
});

export const CommitCandidateSchema = Schema.Struct({
  sha: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  author: Schema.String,
  date: Schema.String,
  ticketRef: Schema.String,
});

export type CommitCandidate = Schema.Schema.Type<typeof CommitCandidateSchema>;

export const OverviewDataSchema = Schema.Struct({
  meta: Schema.Struct({
    projectName: Schema.String,
    theme: WorkbenchThemeSchema,
    services: Schema.Array(ExternalServiceStatusSchema),
    snapshot: Schema.String,
    branch: Schema.String,
    commit: Schema.String,
    repo: Schema.String,
    repositoryUrl: Schema.String,
    docsRoot: Schema.String,
    sources: Schema.Array(OverviewSourceSchema),
  }),
  workItems: Schema.Array(WorkItemRecordSchema),
  maps: Schema.Array(TrackerMapRecordSchema),
  blockerEdges: Schema.Array(BlockerEdgeRecordSchema),
  decisions: Schema.Array(DecisionRecordSchema),
  artifacts: Schema.Array(ArtifactRecordSchema),
  pullRequests: Schema.Array(PullRequestRecordSchema),
  skills: Schema.Array(SkillRecordSchema),
  skillInstalls: Schema.Array(Schema.String),
  sessions: SessionUsageSchema,
  highlights: Schema.Array(CommitCandidateSchema),
});

// Annotating the decoded output with the domain type is the compile-time check
// that the schema stays aligned with it: a field that drifts narrower, wider,
// or missing fails the build instead of the dashboard.
export const parseOverviewData: (input: unknown) => OverviewData = Schema.decodeUnknownSync(
  OverviewDataSchema,
  { onExcessProperty: "error" },
);

export const SubmissionRequestSchema = Schema.Struct({
  sha: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  body: Schema.String,
  author: Schema.NonEmptyString,
  ticketRef: Schema.optional(Schema.String),
});

export const parseSubmissionRequest: (input: unknown) => {
  sha: string;
  subject: string;
  body: string;
  author: string;
  ticketRef?: string;
} = Schema.decodeUnknownSync(SubmissionRequestSchema, { onExcessProperty: "error" });

export const parseCommitCandidate: (input: unknown) => CommitCandidate = Schema.decodeUnknownSync(
  CommitCandidateSchema,
  { onExcessProperty: "error" },
);

export const parseSkillRecord = Schema.decodeUnknownSync(SkillRecordSchema, {
  onExcessProperty: "error",
});

export const parseSkillFlowEdge: (input: unknown) => SkillFlowEdge = Schema.decodeUnknownSync(
  SkillFlowEdgeSchema,
  { onExcessProperty: "error" },
);

export const parseSkillClassification: (input: unknown) => SkillClassification =
  Schema.decodeUnknownSync(SkillClassificationSchema, { onExcessProperty: "error" });

export const parseSkillsStatus: (input: unknown) => SkillsStatus = Schema.decodeUnknownSync(
  SkillsStatusSchema,
  { onExcessProperty: "error" },
);

export const parseWorkItemRecord = Schema.decodeUnknownSync(WorkItemRecordSchema, {
  onExcessProperty: "error",
});

export const parseTrackerMapRecord = Schema.decodeUnknownSync(TrackerMapRecordSchema, {
  onExcessProperty: "error",
});

export const parseBlockerEdgeRecord = Schema.decodeUnknownSync(BlockerEdgeRecordSchema, {
  onExcessProperty: "error",
});

export const parseDecisionRecord = Schema.decodeUnknownSync(DecisionRecordSchema, {
  onExcessProperty: "error",
});

export const parseArtifactRecord = Schema.decodeUnknownSync(ArtifactRecordSchema, {
  onExcessProperty: "error",
});

export const parsePullRequestRecord: (input: unknown) => {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  author: string;
  isDraft: boolean;
  body: string;
} = Schema.decodeUnknownSync(PullRequestRecordSchema, { onExcessProperty: "error" });

export const parseWorkflowStatePayload = Schema.decodeUnknownSync(WorkflowStatePayloadSchema, {
  onExcessProperty: "error",
});

export const parseTriageMoveRequest = Schema.decodeUnknownSync(TriageMoveRequestSchema, {
  onExcessProperty: "error",
});

export const parseTriageMoveResult = Schema.decodeUnknownSync(TriageMoveResultSchema, {
  onExcessProperty: "error",
});

export const parseIssueEditRequest = Schema.decodeUnknownSync(IssueEditRequestSchema, {
  onExcessProperty: "error",
});

export const parseIssueEditResult = Schema.decodeUnknownSync(IssueEditResultSchema, {
  onExcessProperty: "error",
});

export const parseIssueCommentRequest = Schema.decodeUnknownSync(IssueCommentRequestSchema, {
  onExcessProperty: "error",
});

export const parseIssueCommentResult = Schema.decodeUnknownSync(IssueCommentResultSchema, {
  onExcessProperty: "error",
});

export const parseIssueCreateRequest = Schema.decodeUnknownSync(IssueCreateRequestSchema, {
  onExcessProperty: "error",
});

export const parseIssueCreateResult = Schema.decodeUnknownSync(IssueCreateResultSchema, {
  onExcessProperty: "error",
});

export const parseSyncTriggerRequest: (input: unknown) => SyncTriggerRequest =
  Schema.decodeUnknownSync(SyncTriggerRequestSchema, { onExcessProperty: "error" });

export const parseSyncTriggerResult = Schema.decodeUnknownSync(SyncTriggerResultSchema, {
  onExcessProperty: "error",
});

export const parseEdgeAddRequest = Schema.decodeUnknownSync(EdgeAddRequestSchema, {
  onExcessProperty: "error",
});

export const parseEdgeRemoveRequest = Schema.decodeUnknownSync(EdgeRemoveRequestSchema, {
  onExcessProperty: "error",
});

export const parseEdgeWriteResult = Schema.decodeUnknownSync(EdgeWriteResultSchema, {
  onExcessProperty: "error",
});

export const parseAiDraftRequest: (input: unknown) => { pr: number } = Schema.decodeUnknownSync(
  AiDraftRequestSchema,
  { onExcessProperty: "error" },
);

export const parseAiDraftResult: (input: unknown) => { title: string; body: string } =
  Schema.decodeUnknownSync(AiDraftResultSchema, { onExcessProperty: "error" });

export const parseAiHealth: (input: unknown) => { configured: boolean } = Schema.decodeUnknownSync(
  AiHealthSchema,
  { onExcessProperty: "error" },
);

export const parseReviewHealth: (input: unknown) => ReviewHealth = Schema.decodeUnknownSync(
  ReviewHealthSchema,
  { onExcessProperty: "error" },
);

// The run request (epic #20, ticket #26; widened by issue #40): the page
// names an engine and exactly one target — a PR for the review engines, an
// issue for the issue agent, with an optional Ollama model and base branch.
// No command text ever crosses the seam: the model must be
// provider-qualified for the local Ollama server, the branch a plain git
// ref, and both are validated here because they still ride enumerated argv.
export const ReviewRunRequestSchema = Schema.Struct({
  engine: Schema.Literals(engines),
  pr: Schema.optional(Schema.Number),
  issue: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  baseBranch: Schema.optional(Schema.String),
});

export type ReviewRunRequest = Schema.Schema.Type<typeof ReviewRunRequestSchema>;

const positiveInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
};

export const parseReviewRunRequest: (input: unknown) => ReviewRunRequest = (input) => {
  const request = Schema.decodeUnknownSync(ReviewRunRequestSchema, {
    onExcessProperty: "error",
  })(input);
  if (
    (request.pr === undefined && request.issue === undefined) ||
    (request.pr !== undefined && request.issue !== undefined)
  ) {
    throw new Error("exactly one of pr or issue is required");
  }
  if (request.pr !== undefined) positiveInteger(request.pr, "pr");
  if (request.issue !== undefined) positiveInteger(request.issue, "issue");
  if (
    request.model !== undefined &&
    !/^ollama\/[A-Za-z0-9][A-Za-z0-9._:+~^-]{0,80}$/.test(request.model)
  ) {
    throw new Error("model must be an ollama-qualified model id (ollama/<model>)");
  }
  if (
    request.baseBranch !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(request.baseBranch)
  ) {
    throw new Error("baseBranch must be a git branch name");
  }
  return request;
};

export const ReviewCancelRequestSchema = Schema.Struct({
  engine: Schema.Literals(reviewEngines),
});

export type ReviewCancelRequest = Schema.Schema.Type<typeof ReviewCancelRequestSchema>;

export const parseReviewCancelRequest: (input: unknown) => ReviewCancelRequest =
  Schema.decodeUnknownSync(ReviewCancelRequestSchema, { onExcessProperty: "error" });

// The run's event stream (epic #20, ticket #26; issue #40): the runner's
// typed events as the UI consumes them — a started echo of the request (the
// PR for reviews, the issue and model for the agent), output chunks, a
// distinct truncation marker, notices surfaced from the agent's stream, the
// exit (with the cancelled flag), and named errors.
export const ReviewRunEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("started"),
    engine: Schema.Literals(reviewEngines),
    pr: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("started"),
    engine: Schema.Literal("opencode"),
    issue: Schema.Number,
    model: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("output"),
    stream: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("truncated") }),
  Schema.Struct({
    type: Schema.Literal("notice"),
    message: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    code: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.String),
    cancelled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    reason: Schema.Literals(["timeout", "spawn_failed", "step_failed", "engine_unavailable"]),
    message: Schema.String,
  }),
]);

export type ReviewRunEvent = Schema.Schema.Type<typeof ReviewRunEventSchema>;

export const parseReviewRunEvent: (input: unknown) => ReviewRunEvent = Schema.decodeUnknownSync(
  ReviewRunEventSchema,
  { onExcessProperty: "error" },
);

export const parseReviewCommentRequest: (input: unknown) => ReviewCommentRequest =
  Schema.decodeUnknownSync(ReviewCommentRequestSchema, { onExcessProperty: "error" });

export const parseReviewCommentResult: (input: unknown) => ReviewCommentResult =
  Schema.decodeUnknownSync(ReviewCommentResultSchema, { onExcessProperty: "error" });

// The session run history (epic #20, ticket #27): the runs this dev-server
// session has already finished, newest first — what the dashboard's history
// panel lists, re-opens, and re-runs. In-memory only: a dev-server restart
// resets it.
export const ReviewRunOutcomeSchema = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const ReviewHistoryEntrySchema = Schema.Struct({
  id: Schema.Number,
  engine: Schema.Literals(engines),
  // The run's target: a PR for the review engines, an issue for the agent —
  // an entry always carries exactly one, and the panel labels it from these.
  pr: Schema.NullOr(Schema.Number),
  issue: Schema.optional(Schema.Number),
  outcome: ReviewRunOutcomeSchema,
  durationMs: Schema.Number,
  output: Schema.String,
  truncated: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});

export const ReviewHistorySchema = Schema.Struct({
  runs: Schema.Array(ReviewHistoryEntrySchema),
});

export const parseReviewHistory: (input: unknown) => ReviewHistory = Schema.decodeUnknownSync(
  ReviewHistorySchema,
  { onExcessProperty: "error" },
);

export const LlmTurnSchema = Schema.Struct({
  request_id: Schema.String,
  turn_id: Schema.NullOr(Schema.String),
  model: Schema.String,
  status: Schema.String,
  http_status: Schema.NullOr(Schema.Number),
  input_tokens: Schema.NullOr(Schema.Number),
  output_tokens: Schema.NullOr(Schema.Number),
  duration_ms: Schema.NullOr(Schema.Number),
  received_at: Schema.String,
});

export const LlmMessageSchema = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
});

export const LlmTranscriptSchema = Schema.Struct({
  session: Schema.String,
  messages: Schema.Array(LlmMessageSchema),
  turns: Schema.Array(LlmTurnSchema),
});

export const LlmSessionSummarySchema = Schema.Struct({
  session_id: Schema.String,
  requests: Schema.Number,
  models: Schema.Array(Schema.String),
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_tokens: Schema.Number,
  first_at: Schema.String,
  last_at: Schema.String,
});

export const LlmSessionsIndexSchema = Schema.Struct({
  sessions: Schema.Array(LlmSessionSummarySchema),
});

export type LlmTurn = Schema.Schema.Type<typeof LlmTurnSchema>;
export type LlmMessage = Schema.Schema.Type<typeof LlmMessageSchema>;
export type LlmTranscript = Schema.Schema.Type<typeof LlmTranscriptSchema>;
export type LlmSessionSummary = Schema.Schema.Type<typeof LlmSessionSummarySchema>;

export const parseLlmTranscript: (input: unknown) => LlmTranscript = Schema.decodeUnknownSync(
  LlmTranscriptSchema,
  { onExcessProperty: "ignore" },
);

export const parseLlmSessions: (input: unknown) => { sessions: readonly LlmSessionSummary[] } =
  Schema.decodeUnknownSync(LlmSessionsIndexSchema, { onExcessProperty: "ignore" });
