import { Schema } from "effect";

import type {
  OverviewData,
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
});

// Annotating the decoded output with the domain type is the compile-time check
// that the schema stays aligned with it: a field that drifts narrower, wider,
// or missing fails the build instead of the dashboard.
export const parseOverviewData: (input: unknown) => OverviewData = Schema.decodeUnknownSync(
  OverviewDataSchema,
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
