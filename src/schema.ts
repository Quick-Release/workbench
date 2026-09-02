import { Schema } from "effect";

import type { OverviewData } from "./types";
import { serviceStatuses, ticketKinds, ticketStatuses } from "./types";

export const TicketStatusSchema = Schema.Literal(...ticketStatuses);

export const TicketKindSchema = Schema.Literal(...ticketKinds);

export const ServiceStatusSchema = Schema.Literal(...serviceStatuses);

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
