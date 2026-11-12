import type { ClarificationEventEnvelope } from "../schema";
import type {
  ClarificationConversationState,
  ClarificationInspectionResult,
  ClarificationRunResult,
} from "../types";

// The run inspection display projection (spec #221, ticket #237; Factory 11,
// #169): every word the issue panel's run section shows, as pure functions
// over the seam's reads — the run section, the conversation state, and the
// inspection read. Nothing here fetches, and nothing here owns a state
// machine: each axis renders its owner's own vocabulary verbatim
// (run/attempt lifecycle from the durable store, ADR 0020; conversation
// state from the managed session, ADR 0018; readiness from the context
// packet, ADR 0017; usage line kinds from the failure policy, ADR 0023).
// There is deliberately no function that merges axes into one status word,
// and none that reads or writes a workflow phase — the phase is GitHub's,
// run state is Workbench's.

type Section = ClarificationRunResult;
type Ledger = readonly ClarificationEventEnvelope[];

// The display tones. There is no success tone on purpose: no state renders
// green, so "unknown" can never be averaged into a reassuring color, and
// `unknown` has its own tone — the word, styled distinctly, never a spinner.
export type InspectionTone = "neutral" | "attention" | "unknown" | "closed";

export const UNKNOWN = "unknown";

const toneOfLifecycle = (state: string): InspectionTone => {
  if (state === "unknown") return "unknown";
  if (state === "awaiting-human" || state === "reconciling" || state === "quarantined")
    return "attention";
  if (state === "terminal") return "closed";
  return "neutral";
};

const toneOfVerdict = (verdict: string): InspectionTone => {
  if (verdict === "unknown") return "unknown";
  if (verdict === "needs-information" || verdict === "unsupported") return "attention";
  return "neutral";
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// ES2022 has no Array.prototype.findLast; the newest match, by hand.
const findLast = <T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (predicate(items[index])) return items[index];
  return undefined;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

// --- Attempts: ordinal and origin, so a retry reads as a second segment. ---

export type AttemptLine = {
  attemptId: string;
  ordinal: number;
  word: string;
  tone: InspectionTone;
  origin: string;
  classification: string | null;
};

const originText = (origin: string, ordinal: number) => {
  if (origin === "coordinator-retry")
    return "started by the one coordinator retry — durable evidence proved no dispatch";
  return ordinal === 1 ? "started by your explicit start" : "started after manual retry";
};

// The latest failure-policy classification per attempt, from the ledger's
// outcome evidence — the record's own words, never re-derived.
const classificationsOf = (events: Ledger) => {
  const byAttempt = new Map<string, string>();
  for (const { event } of events) {
    if (event.type !== "operational") continue;
    const data = record(event.data);
    const attemptId = text(data.attemptId);
    if (attemptId === null) continue;
    if (event.kind === "attempt.outcome" && text(data.classification))
      byAttempt.set(attemptId, String(data.classification));
    if (event.kind === "attempt.start-denied") byAttempt.set(attemptId, "start denied");
    if (event.kind === "attempt.process-death") byAttempt.set(attemptId, UNKNOWN);
  }
  return byAttempt;
};

export const attemptLines = (section: Section): AttemptLine[] => {
  const classifications = classificationsOf(section.events);
  return section.attempts.map((attempt, index) => ({
    attemptId: attempt.attemptId,
    ordinal: index + 1,
    word: attempt.state,
    tone: toneOfLifecycle(attempt.state),
    origin: originText(attempt.origin, index + 1),
    classification: classifications.get(attempt.attemptId) ?? null,
  }));
};

// --- The status axes, panel per axis. ---

export type UsageCell = { kind: "reported" | "estimated" | "unknown"; text: string };

export type StatusAxes = {
  lifecycle: { word: string; tone: InspectionTone; note: string | null };
  attempts: AttemptLine[];
  conversation: { word: string; tone: InspectionTone; note: string | null };
  readiness: { axis: string; word: string; tone: InspectionTone; reasons: readonly string[] }[];
  usage: UsageCell[];
};

const READINESS_AXES = [
  "tracker-eligibility",
  "brief-completeness",
  "host-capability",
  "research-sufficiency",
  "authorization",
] as const;

const sums = (totals: Record<string, number>) =>
  Object.entries(totals).map(([unit, value]) => `${value.toLocaleString("en-US")} ${unit}`);

const usageCells = (inspection: ClarificationInspectionResult | null): UsageCell[] => {
  // No inspection read: every kind is unknown — the word, not a zero.
  if (inspection === null)
    return [
      { kind: "reported", text: UNKNOWN },
      { kind: "estimated", text: UNKNOWN },
      { kind: "unknown", text: UNKNOWN },
    ];
  const { totals } = inspection.usage;
  const reported = sums(totals.reported);
  const estimated = sums(totals.estimated);
  return [
    { kind: "reported", text: reported.length > 0 ? reported.join(", ") : "none recorded" },
    { kind: "estimated", text: estimated.length > 0 ? estimated.join(", ") : "none recorded" },
    {
      kind: "unknown",
      text:
        totals.unknownLines > 0
          ? `${totals.unknownLines} line${totals.unknownLines === 1 ? "" : "s"} — no number exists`
          : "none recorded",
    },
  ];
};

// Whether a turn is live, from the evidence: a prompt whose settlement or
// stop has not been observed yet. A prompt the runtime never accepted (its
// acceptance failed) freed the floor when it failed.
export const turnInFlight = (events: Ledger) => {
  let live = false;
  for (const { event } of events) {
    if (event.type === "operational" && event.kind === "conversation.prompt") live = true;
    if (event.type === "operational" && event.kind === "conversation.turn-stopped") live = false;
    if (event.type === "operational" && event.kind === "conversation.prompt-failed") live = false;
    if (event.type === "conversation") {
      const frame = record(event.session.event);
      if (frame.type === "agent_settled") live = false;
    }
  }
  return live;
};

export const liveAttemptOf = (section: Section) =>
  findLast(section.attempts, (attempt) => attempt.state !== "terminal") ?? null;

export const statusAxes = ({
  section,
  conversationState,
  inspection,
}: {
  section: Section;
  conversationState: ClarificationConversationState | null;
  inspection: ClarificationInspectionResult | null;
}): StatusAxes => {
  const { run } = section;
  const live = liveAttemptOf(section);
  // The conversation's word is the managed session's own. No live attempt,
  // no state read, or a session this install is not driving: the honest
  // word is unknown — never "idle", never a spinner.
  const conversation =
    live === null
      ? {
          word: "none live",
          tone: "closed" as const,
          note: "no attempt is live — the recorded conversation stays readable",
        }
      : conversationState?.available && text(conversationState.sessionState)
        ? { word: String(conversationState.sessionState), tone: "neutral" as const, note: null }
        : {
            word: UNKNOWN,
            tone: "unknown" as const,
            note:
              conversationState?.available === false
                ? "the managed session is not live on this install"
                : "the conversation state could not be read",
          };
  const readiness = READINESS_AXES.map((axis) => {
    const found = inspection?.readiness.axes.find((entry) => entry.axis === axis);
    return found
      ? {
          axis,
          word: found.verdict,
          tone: toneOfVerdict(found.verdict),
          reasons: found.reasons,
        }
      : { axis, word: UNKNOWN, tone: "unknown" as const, reasons: [] };
  });
  return {
    lifecycle: {
      word: run.state,
      tone: toneOfLifecycle(run.state),
      note: run.discardedAt
        ? `retained evidence discarded at ${run.discardedAt} — the record stays`
        : null,
    },
    attempts: attemptLines(section),
    conversation,
    readiness,
    usage: usageCells(inspection),
  };
};

// --- The operational timeline: one per run, segmented by attempt. ---

export type TimelineEntry = {
  cursor: number;
  at: string | null;
  text: string;
  tone: InspectionTone;
  raw: unknown;
};

export type TimelineSegment = {
  key: string;
  attemptId: string | null;
  heading: string;
  entries: TimelineEntry[];
  // The conversation is referenced, never duplicated: a count and a
  // pointer to the conversation surface, no transcript text.
  conversationEvents: number;
};

export type Timeline = {
  gap: { text: string; missing: number } | null;
  discarded: string | null;
  segments: TimelineSegment[];
};

const outcomeText = (data: Record<string, unknown>) => {
  const detail = [text(data.kind), text(data.reason)].filter(Boolean).join(", ");
  return `outcome classified ${String(data.classification ?? UNKNOWN)}${
    detail ? ` (${detail})` : ""
  } — next: ${String(data.nextAction ?? UNKNOWN)}`;
};

// One operational event in plain language. The raw event stays behind the
// entry's expand; unknown kinds keep their own name, never a silent drop.
export const plainLanguage = (kind: string, data: Record<string, unknown>): string => {
  switch (kind) {
    case "run.started":
      return `run started${text(data.issueId) ? ` for issue #${String(data.issueId)}` : ""}`;
    case "attempt.recorded":
      return data.retry === true
        ? "fresh attempt recorded after your manual retry"
        : "attempt recorded against the pinned issue revision";
    case "attempt.start-denied":
      return `the managed session was denied before it could start (${String(data.code ?? UNKNOWN)})`;
    case "attempt.dispatched":
      return "the dispatch window opened — no-dispatch can no longer be proven";
    case "attempt.outcome":
      return outcomeText(data);
    case "attempt.coordinator-retried":
      return "the one coordinator retry fired — durable evidence proved no dispatch";
    case "attempt.process-death":
      return "the managed runtime died — the outcome is unknown until reconciled";
    case "attempt.cancelled":
      return "you cancelled the attempt";
    case "attempt.superseded":
      return "the parked attempt was closed by your fresh attempt";
    case "attempt.reconciliation.started":
    case "run.reconciliation.started":
      return `reconciliation started (from ${String(data.from ?? UNKNOWN)})`;
    case "attempt.reconciliation.resolved":
    case "run.reconciliation.resolved":
      return `reconciliation resolved to ${String(data.to ?? UNKNOWN)}${
        text(data.basis) ? ` — basis: ${String(data.basis)}` : ""
      }`;
    case "run.halted":
      return `run halted for a human: the same ${String(data.classification ?? "failure")} repeated ${String(
        data.repeats ?? "",
      )}×`;
    case "run.evidence-retained":
      return "you retained this run's evidence for inspection";
    case "draft.saved":
      return `draft saved (${String(data.profile ?? UNKNOWN)}, ${String(
        data.gapCount ?? "?",
      )} gap(s)) — saving is not approval`;
    case "publication.approved":
      return "you approved the exact issue-body diff";
    case "publication.blocked":
      return `publication blocked${text(data.reason) ? `: ${String(data.reason)}` : ""}`;
    case "publication.failed":
      return `publication failed${text(data.reason) ? `: ${String(data.reason)}` : ""}`;
    case "publication.uncertain":
      return "publication outcome unknown — reconcile before anything retries";
    case "publication.succeeded":
      return "issue body published and proven by read-back";
    default:
      return kind.replaceAll(".", " · ");
  }
};

const entryTone = (kind: string, data: Record<string, unknown>): InspectionTone => {
  if (
    kind === "attempt.process-death" ||
    kind === "publication.uncertain" ||
    data.classification === "unknown" ||
    data.to === "unknown"
  )
    return "unknown";
  if (
    kind === "attempt.start-denied" ||
    kind === "run.halted" ||
    kind.endsWith(".failed") ||
    kind.endsWith(".blocked")
  )
    return "attention";
  return "neutral";
};

const isConversationEvent = (envelope: ClarificationEventEnvelope) =>
  envelope.event.type === "conversation" ||
  (envelope.event.type === "operational" && envelope.event.kind.startsWith("conversation."));

const attemptOfEvent = (envelope: ClarificationEventEnvelope): string | null => {
  const { event } = envelope;
  if (event.type === "conversation") return event.attemptId;
  if (event.type === "lifecycle") return event.scope === "attempt" ? event.id : null;
  return text(record(event.data).attemptId);
};

export const operationalTimeline = (section: Section): Timeline => {
  const attempts = attemptLines(section);
  const byId = new Map(attempts.map((line) => [line.attemptId, line]));
  const segments: TimelineSegment[] = [];
  const segmentFor = (attemptId: string | null): TimelineSegment => {
    // Run-level events land in the segment of the attempt current at the
    // time, so chronology holds; before any attempt they open the run.
    const current = segments.at(-1);
    if (current && (attemptId === null || current.attemptId === attemptId)) return current;
    const line = attemptId === null ? undefined : byId.get(attemptId);
    const segment: TimelineSegment = {
      key: `${attemptId ?? "run"}-${segments.length}`,
      attemptId,
      heading:
        attemptId === null
          ? "run"
          : line
            ? `attempt ${line.ordinal} — ${line.origin}`
            : `attempt ${attemptId}`,
      entries: [],
      conversationEvents: 0,
    };
    segments.push(segment);
    return segment;
  };

  for (const envelope of section.events) {
    const segment = segmentFor(attemptOfEvent(envelope));
    if (isConversationEvent(envelope)) {
      segment.conversationEvents += 1;
      continue;
    }
    const { event } = envelope;
    if (event.type === "lifecycle") {
      segment.entries.push({
        cursor: envelope.cursor,
        at: event.at,
        text: `${event.scope} moved to ${event.state}`,
        tone: toneOfLifecycle(event.state),
        raw: event,
      });
      continue;
    }
    if (event.type !== "operational") continue;
    const data = record(event.data);
    segment.entries.push({
      cursor: envelope.cursor,
      at: event.at,
      text: plainLanguage(event.kind, data),
      tone: entryTone(event.kind, data),
      raw: event,
    });
  }

  const gap = section.gap
    ? (() => {
        const missing = Math.max(0, section.gap.firstRetainedCursor - section.gap.after - 1);
        return {
          missing,
          text: `— ${missing} earlier event${missing === 1 ? "" : "s"} not retained —`,
        };
      })()
    : null;
  return {
    gap,
    discarded: section.run.discardedAt
      ? `— retained evidence discarded at ${section.run.discardedAt}; the event history is gone —`
      : null,
    segments,
  };
};

// --- Ownership and the "controls moved" notice. ---

// The controller lease is the coordinator's; viewers never hold it. What a
// tab can honestly know is whose explicit act — a request id it issued, or
// one it did not — last moved the record while the lease stands. Fencing is
// the correctness mechanism; this display is courtesy, not security.
export type Ownership = {
  state: "this-tab" | "another-viewer" | "unheld";
  text: string;
  controlsMoved: boolean;
};

const actsOf = (events: Ledger) =>
  events.flatMap(({ cursor, event }) => {
    if (event.type !== "operational") return [];
    const requestId = text(record(event.data).requestId);
    return requestId === null ? [] : [{ cursor, requestId }];
  });

export const ownershipFor = ({
  inspection,
  events,
  ownRequestIds,
  now,
}: {
  inspection: ClarificationInspectionResult | null;
  events: Ledger;
  ownRequestIds: ReadonlySet<string>;
  now: number;
}): Ownership => {
  const lease = inspection?.lease ?? null;
  const live = lease !== null && !lease.expired && Date.parse(lease.expiresAt) > now;
  const acts = actsOf(events);
  const last = acts.at(-1);
  const actedHere = acts.some((act) => ownRequestIds.has(act.requestId));
  if (!live || last === undefined)
    return {
      state: "unheld",
      text: "unheld — this tab acquires on its first action",
      controlsMoved: false,
    };
  if (ownRequestIds.has(last.requestId))
    return { state: "this-tab", text: "controls held by this tab", controlsMoved: false };
  return {
    state: "another-viewer",
    text: "held by another viewer",
    controlsMoved: actedHere,
  };
};

// --- The action matrix. ---

export type ActionId =
  | "detach"
  | "reconnect"
  | "reconcile"
  | "follow-live"
  | "stop-turn"
  | "cancel-attempt"
  | "retain-evidence"
  | "discard-evidence"
  | "retry"
  | "publish";

export type ActionClass = "direct" | "two-step" | "typed" | "fresh-approval";

export type MatrixAction = {
  id: ActionId;
  class: ActionClass;
  label: string;
  consequence: string;
  destructive: boolean;
  available: boolean;
  // Where the act lives when another surface owns it: stop turn is the
  // conversation's, publish is the draft's — referenced, never duplicated.
  surface: "run" | "conversation" | "draft";
};

const RECOVERY_STATES = ["awaiting-human", "unknown", "quarantined"];

export const retryEligible = (section: Section) =>
  !section.run.discardedAt &&
  (section.run.state === "awaiting-human" || section.run.state === "active") &&
  section.attempts.every(
    (attempt) => attempt.state === "terminal" || attempt.state === "awaiting-human",
  ) &&
  section.attempts.length > 0;

const cancellableAttempt = (section: Section) =>
  findLast(
    section.attempts,
    (attempt) => attempt.state === "active" || attempt.state === "awaiting-human",
  ) ?? null;

export const actionMatrix = ({
  section,
  following,
  turnLive,
}: {
  section: Section;
  following: boolean;
  turnLive: boolean;
}): MatrixAction[] => {
  const discarded = Boolean(section.run.discardedAt);
  const recovery = RECOVERY_STATES.includes(section.run.state) && !discarded;
  return [
    {
      id: "detach",
      class: "direct",
      label: "Detach",
      consequence: "Stop watching. The run keeps going.",
      destructive: false,
      available: following,
      surface: "run",
    },
    {
      id: "reconnect",
      class: "direct",
      label: "Reconnect",
      consequence: "Snapshot plus the events after your cursor; a gap divider if events expired.",
      destructive: false,
      available: !following,
      surface: "run",
    },
    {
      id: "reconcile",
      class: "direct",
      label: "Inspect (read-only reconcile)",
      consequence:
        "Re-read the lease, attempts, termination and publication evidence. Changes nothing.",
      destructive: false,
      available: true,
      surface: "run",
    },
    {
      id: "stop-turn",
      class: "two-step",
      label: "Stop turn",
      consequence: "Finish the current turn, keep the attempt alive — on the conversation above.",
      destructive: false,
      available: turnLive,
      surface: "conversation",
    },
    {
      id: "cancel-attempt",
      class: "two-step",
      label: "Cancel attempt",
      consequence: "Stop the attempt. Its evidence stays until you discard or retain it.",
      destructive: false,
      available: cancellableAttempt(section) !== null,
      surface: "run",
    },
    {
      id: "retain-evidence",
      class: "two-step",
      label: "Retain evidence",
      consequence: "Keep this run's evidence for inspection. Nothing is deleted.",
      destructive: false,
      available: recovery,
      surface: "run",
    },
    {
      id: "discard-evidence",
      class: "typed",
      label: "Discard evidence",
      consequence:
        "Deletes this run's retained event evidence. Unrecoverable — type the run id to confirm.",
      destructive: true,
      available: recovery,
      surface: "run",
    },
    {
      id: "retry",
      class: "fresh-approval",
      label: "Retry as fresh attempt",
      consequence: "The manifest re-renders; your fresh approval starts a new attempt ID.",
      destructive: false,
      available: retryEligible(section),
      surface: "run",
    },
    {
      id: "publish",
      class: "fresh-approval",
      label: "Approve and update issue",
      consequence: "Its own approval of the exact visible diff — on the draft below.",
      destructive: false,
      available: !discarded,
      surface: "draft",
    },
  ];
};

export const cancelTargetOf = (section: Section) => cancellableAttempt(section)?.attemptId ?? null;

// --- The "Where you left off" return card. ---

export type ReturnCard = {
  reason: "gap" | "awaiting-human" | "reconciling";
  fields: {
    state: string;
    ownership: string;
    lastTrustedEvent: string;
    changedFiles: string;
    checks: string;
    missingDecision: string;
  };
  primary: { id: ActionId; label: string };
};

const lastTrustedEvent = (events: Ledger) => {
  const last = events.at(-1);
  if (last === undefined) return "none retained";
  const { event } = last;
  const at = event.type === "conversation" ? null : event.at;
  const what =
    event.type === "operational"
      ? plainLanguage(event.kind, record(event.data))
      : event.type === "lifecycle"
        ? `${event.scope} moved to ${event.state}`
        : "a conversation event";
  return `#${last.cursor} · ${what}${at ? ` · ${at}` : ""}`;
};

const missingDecisionFor = (
  section: Section,
  inspection: ClarificationInspectionResult | null,
  reason: ReturnCard["reason"],
) => {
  const escalation = inspection?.escalations.at(-1);
  if (escalation)
    return `${escalation.decision} — the same ${escalation.classification} (${
      escalation.reason ?? escalation.kind
    }) failure repeated ${escalation.repeats}×`;
  if (reason === "reconciling")
    return "reconciliation is inspecting this run — read what it found before deciding";
  const parked = findLast(section.attempts, (attempt) => attempt.state === "awaiting-human");
  if (parked) {
    const outcome = findLast(
      section.events,
      ({ event }) =>
        event.type === "operational" &&
        event.kind === "attempt.outcome" &&
        record(event.data).attemptId === parked.attemptId,
    );
    const why =
      outcome?.event.type === "operational" ? text(record(outcome.event.data).reason) : null;
    return `the provider refused${why ? ` (${why})` : ""} and the usage budget is preserved — retry as a fresh attempt once that is resolved, or cancel the attempt?`;
  }
  if (section.run.state === "awaiting-human") {
    const denied = section.events.some(
      ({ event }) => event.type === "operational" && event.kind === "attempt.start-denied",
    );
    return denied
      ? "the managed session was denied before it could start — retry as a fresh attempt, retain the evidence, or discard it?"
      : "this run waits for your decision — retry as a fresh attempt, retain the evidence, or discard it?";
  }
  return "none — the run continues; events before the gap are no longer retained";
};

export const returnCardFor = ({
  section,
  inspection,
  ownership,
}: {
  section: Section;
  inspection: ClarificationInspectionResult | null;
  ownership: Ownership;
}): ReturnCard | null => {
  const parked = section.attempts.some((attempt) => attempt.state === "awaiting-human");
  const reason: ReturnCard["reason"] | null =
    section.run.state === "reconciling"
      ? "reconciling"
      : section.run.state === "awaiting-human" || parked
        ? "awaiting-human"
        : section.gap
          ? "gap"
          : null;
  if (reason === null || section.run.discardedAt) return null;

  const latest = section.attempts.at(-1);
  const readinessWords = READINESS_AXES.map((axis) => {
    const found = inspection?.readiness.axes.find((entry) => entry.axis === axis);
    return `${axis} ${found?.verdict ?? UNKNOWN}`;
  }).join(" · ");

  // Exactly one primary next safe action, drawn from the matrix.
  const primary: ReturnCard["primary"] =
    reason === "reconciling"
      ? { id: "reconcile", label: "Inspect (read-only reconcile)" }
      : reason === "awaiting-human" && retryEligible(section)
        ? { id: "retry", label: "Start fresh attempt" }
        : reason === "awaiting-human"
          ? { id: "reconcile", label: "Inspect (read-only reconcile)" }
          : { id: "follow-live", label: "Follow live" };

  return {
    reason,
    fields: {
      state: `run ${section.run.state}${
        latest ? ` · attempt ${section.attempts.length} ${latest.state}` : ""
      }`,
      ownership: ownership.text,
      lastTrustedEvent: lastTrustedEvent(section.events),
      changedFiles: "none — a Clarification attempt writes no files and has no workspace",
      checks: `readiness: ${readinessWords}`,
      missingDecision: missingDecisionFor(section, inspection, reason),
    },
    primary,
  };
};

// --- In flight: the run-status chip, zero actions. ---

export type RunChip = { label: string; word: string; tone: InspectionTone };

export const runChipFor = (state: string): RunChip => ({
  label: `clarification ${state}`,
  word: state,
  tone: toneOfLifecycle(state),
});

// The display classes per tone, shared by every inspection surface. No tone
// is green, and `unknown` is amber with the word — never a spinner.
export const toneClass: Record<InspectionTone, string> = {
  neutral: "border-border text-foreground",
  attention: "border-orange-500/60 text-orange-700 dark:text-orange-300",
  unknown: "border-amber-500/70 text-amber-700 dark:text-amber-300",
  closed: "border-border text-muted-foreground",
};
