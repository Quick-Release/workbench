import { Schema } from "effect";

import type { OverviewData, SkillClassification, SkillFlowEdge, SkillsStatus } from "./types";
import {
  serviceStatuses,
  skillFlowEdgeKinds,
  skillFlowRoles,
  ticketKinds,
  ticketStatuses,
} from "./types";
export const TicketStatusSchema = Schema.Literals(ticketStatuses);

export const TicketKindSchema = Schema.Literals(ticketKinds);

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

export const TicketRecordSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: TicketStatusSchema,
  statusLabel: Schema.String,
  statusDetail: Schema.String,
  group: Schema.String,
  lane: Schema.String,
  dependencies: Schema.String,
  summary: Schema.String,
  sourcePath: Schema.String,
  sourceUrl: Schema.String,
  kind: TicketKindSchema,
  externalSource: Schema.optional(Schema.String),
  progress: Schema.Struct({ done: Schema.Number, total: Schema.Number }),
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

export const parseTicketRecord = Schema.decodeUnknownSync(TicketRecordSchema, {
  onExcessProperty: "error",
});

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
