import { Schema } from "effect";

import type { OverviewData } from "./types";
import {
  artifactKinds,
  blockerEdgeSources,
  decisionSources,
  decisionStatuses,
  serviceStatuses,
  ticketKinds,
  ticketStatuses,
  trackerCategories,
  triageStates,
  wayfinderKinds,
  workflowPhases,
} from "./types";
export const TicketStatusSchema = Schema.Literals(ticketStatuses);

export const TicketKindSchema = Schema.Literals(ticketKinds);

export const ServiceStatusSchema = Schema.Literals(serviceStatuses);

export const WorkflowPhaseSchema = Schema.NullOr(Schema.Literals(workflowPhases));

export const TriageStateSchema = Schema.Literals(triageStates);

export const WayfinderKindSchema = Schema.NullOr(Schema.Literals(wayfinderKinds));

export const TrackerCategorySchema = Schema.NullOr(Schema.Literals(trackerCategories));

export const TicketRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: TicketStatusSchema,
  statusLabel: Schema.String,
  statusDetail: Schema.String,
  group: Schema.String,
  lane: Schema.String,
  summary: Schema.String,
  sourcePath: Schema.String,
  sourceUrl: Schema.String,
  kind: TicketKindSchema,
  externalSource: Schema.optional(Schema.String),
  progress: Schema.Struct({ done: Schema.Number, total: Schema.Number }),
});

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

export const PlanRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: TicketStatusSchema,
  statusLabel: Schema.String,
  statusDetail: Schema.String,
  stream: Schema.String,
  ticketCount: Schema.Number,
  openTicketCount: Schema.Number,
  completeTicketCount: Schema.Number,
  summary: Schema.String,
  sourcePath: Schema.String,
  sourceUrl: Schema.String,
});

export const SpecChangeRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: TicketStatusSchema,
  statusLabel: Schema.String,
  summary: Schema.String,
  taskCount: Schema.Number,
  completeTaskCount: Schema.Number,
  sourcePath: Schema.String,
  sourceUrl: Schema.String,
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
    ticketCount: Schema.Number,
    planCount: Schema.Number,
    changeCount: Schema.Number,
  }),
  tickets: Schema.Array(TicketRecordSchema),
  plans: Schema.Array(PlanRecordSchema),
  changes: Schema.Array(SpecChangeRecordSchema),
  workItems: Schema.Array(WorkItemRecordSchema),
  maps: Schema.Array(TrackerMapRecordSchema),
  blockerEdges: Schema.Array(BlockerEdgeRecordSchema),
  decisions: Schema.Array(DecisionRecordSchema),
  artifacts: Schema.Array(ArtifactRecordSchema),
  sessions: SessionUsageSchema,
});

// Annotating the decoded output with the domain type is the compile-time check
// that the schema stays aligned with it: a field that drifts narrower, wider,
// or missing fails the build instead of the dashboard.
export const parseOverviewData: (input: unknown) => OverviewData = Schema.decodeUnknownSync(
  OverviewDataSchema,
  { onExcessProperty: "error" },
);

export const parseTicketRecord = Schema.decodeUnknownSync(TicketRecordSchema, {
  onExcessProperty: "error",
});

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
