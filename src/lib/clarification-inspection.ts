import type {
  ClarificationConversationState,
  ClarificationEventEnvelope,
  ClarificationLeaseView,
  ClarificationRunResult,
  ClarificationRunSnapshot,
  ClarificationRunSummary,
  ClarificationUsageLine,
  ClarificationUsageTotals,
} from "../schema";
import type { ClarificationAttemptOrigin } from "../types";
// The explicit extension is load-bearing: the seam-side drift fence
// imports this module under raw node (node --test), where relative ESM
// imports must be extensioned.
import { clarificationLeaseOwner } from "../types.ts";

// The inspection display's projection (spec #221, ticket #237, Factory 11):
// pure functions over the settled record contracts — a display projection,
// never a state machine. Every word these functions emit comes from an
// existing owner: run and attempt lifecycles from the durable store, the
// conversation state from the managed-session surface, readiness from the
// draft completeness, usage from the budget's own line kinds, workflow
// phases from GitHub (never from here). No merged status word exists at
// this layer, unknown renders as the word, and nothing here recommends or
// acts.

// A section's optional conversation read: the same shape the conversation
// route answers, or its honest absence.
export type ConversationInput = Pick<ClarificationConversationState, "available"> & {
  sessionState?: string | undefined;
};

// The readiness axis rides on the draft completeness read (ADR 0017's brief
// completeness dimension): its owner's two verdicts, or nothing.
export type ReadinessInput = { verdict: "ready" | "needs-information"; gaps: readonly unknown[] };

export type StatusPanel =
  | { axis: "run"; state: string; discardedAt: string | null }
  | {
      axis: "attempts";
      attempts: readonly {
        attemptId: string;
        state: string;
        origin: ClarificationAttemptOrigin;
        dispatchedAt?: string;
      }[];
    }
  | { axis: "conversation"; state: string; live: boolean }
  | { axis: "readiness"; verdict: "ready" | "needs-information" | "unknown"; gapCount: number }
  | {
      axis: "usage";
      lines: readonly ClarificationUsageLine[];
      totals: ClarificationUsageTotals;
    };

// Panel-per-axis: the five settled axes, each carrying only its owner's
// vocabulary. The conversation axis renders the session's own word — or the
// word "unknown" when no live session can name one; it never borrows the
// run lifecycle's words. Readiness without a draft read is unknown, never
// guessed.
export const statusPanels = (
  section: Pick<ClarificationRunResult, "run" | "attempts" | "usage">,
  reads: {
    conversation?: ConversationInput | null;
    readiness?: ReadinessInput | null;
  },
): StatusPanel[] => [
  {
    axis: "run",
    state: section.run.state,
    discardedAt: section.run.discardedAt ?? null,
  },
  {
    axis: "attempts",
    attempts: section.attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      state: attempt.state,
      origin: attempt.origin,
      ...(attempt.dispatchedAt !== undefined ? { dispatchedAt: attempt.dispatchedAt } : {}),
    })),
  },
  {
    axis: "conversation",
    state:
      reads.conversation?.available === true && typeof reads.conversation.sessionState === "string"
        ? reads.conversation.sessionState
        : "unknown",
    live: reads.conversation?.available === true,
  },
  {
    axis: "readiness",
    verdict: reads.readiness?.verdict ?? "unknown",
    gapCount: reads.readiness?.gaps.length ?? 0,
  },
  {
    axis: "usage",
    lines: section.usage?.lines ?? [],
    totals: section.usage?.totals ?? { reported: {}, estimated: {}, unknownLines: 0 },
  },
];

// The lease's three display states (Factory 11's ownership display): the
// browser never holds the controller lease — the coordinator acquires it
// implicitly per mutation — so "held" means this install's coordinator, and
// "elsewhere" is the controls-moved fact. An expired lease is unheld: it
// yields to the next acquisition.
export type Ownership =
  | { state: "unheld" }
  | { state: "held"; owner: string; expiresAt: string }
  | { state: "elsewhere"; owner: string; expiresAt: string };

export const ownershipFor = (lease: ClarificationLeaseView | null | undefined): Ownership => {
  if (!lease || lease.expired) return { state: "unheld" };
  if (lease.owner === clarificationLeaseOwner)
    return { state: "held", owner: lease.owner, expiresAt: lease.expiresAt };
  return { state: "elsewhere", owner: lease.owner, expiresAt: lease.expiresAt };
};

// Thousands render compactly ("12.4k"), exactly as Factory 11's usage line
// example does. Values are honest numbers or nothing — never averages.
const formatCount = (value: number) => {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  const rounded = Math.round(thousands * 10) / 10;
  return `${rounded}k`;
};

const formatSums = (sums: Record<string, number>) => {
  const units = Object.keys(sums).sort();
  if (units.length === 0) return "—";
  return units.map((unit) => `${formatCount(sums[unit])} ${unit}`).join(", ");
};

// The budget's honest summary line: every kind in its own word, an empty
// sum as a dash, unknown as a count of lines — never a number.
export const usageTotalsLine = (totals: ClarificationUsageTotals) =>
  `reported ${formatSums(totals.reported)} · estimated ${formatSums(totals.estimated)} · unknown ${totals.unknownLines} ${totals.unknownLines === 1 ? "line" : "lines"}`;

// --- The operational timeline: one per run, segmented by attempt.

export type TimelineEntry = {
  cursor: number;
  sentence: string;
  at?: string;
  detail?: string;
  detailTruncated?: boolean;
  reference?: boolean;
};

export type TimelineSegment = {
  key: string;
  heading: string;
  entries: TimelineEntry[];
};

export type Timeline = {
  gapDivider?: { hiddenCount: number; firstRetainedCursor: number };
  segments: TimelineSegment[];
};

// Raw detail travels verbatim behind the expand, capped — the cap is stated
// in words at the render site, never hidden.
const DETAIL_CAP = 2000;

const truncatedDetail = (data: unknown): { detail: string; detailTruncated: boolean } => {
  const raw = JSON.stringify(data) ?? "";
  return raw.length <= DETAIL_CAP
    ? { detail: raw, detailTruncated: false }
    : { detail: raw.slice(0, DETAIL_CAP), detailTruncated: true };
};

// One timeline entry per ledger envelope, in plain language. The
// conversation's frames never become entries here — the segment carries one
// reference line instead; the chat surface holds the conversation.
const entryFor = (
  envelope: ClarificationEventEnvelope,
  attemptNumbers: ReadonlyMap<string, number>,
): Omit<TimelineEntry, "cursor"> => {
  const { event } = envelope;
  if (event.type === "lifecycle") {
    const detail = truncatedDetail({ id: event.id, state: event.state, at: event.at });
    return {
      sentence:
        event.scope === "run"
          ? `the run moved to ${event.state}`
          : attemptNumbers.has(event.id)
            ? `attempt ${attemptNumbers.get(event.id)} moved to ${event.state}`
            : `an attempt moved to ${event.state}`,
      at: event.at,
      detail: detail.detail,
      ...(detail.detailTruncated ? { detailTruncated: true } : {}),
    };
  }
  // The segments loop handles conversation events as references and never
  // routes them here; the typed branch keeps the narrowing total.
  if (event.type === "conversation") return { sentence: "", reference: true };
  const data = (event.data ?? {}) as Record<string, unknown>;
  const n = typeof data.attemptId === "string" ? attemptNumbers.get(data.attemptId) : undefined;
  const who = n === undefined ? "attempt" : `attempt ${n}`;
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  let sentence: string;
  switch (event.kind) {
    case "run.started":
      sentence =
        data.issueId !== undefined && data.issueId !== null
          ? `run started for issue ${String(data.issueId)}`
          : "run started";
      break;
    case "attempt.recorded":
      sentence = `${who} recorded — the dispatch intent committed before any side effect`;
      break;
    case "attempt.dispatched":
      sentence = `${who}'s managed session dispatched`;
      break;
    case "attempt.start-denied":
      sentence = `${who}'s managed session was denied before it could start (${String(data.code)})`;
      break;
    case "attempt.outcome":
      sentence = `${who} ended: ${String(data.kind)}${reason ? ` (${reason})` : ""} — the record's next action: ${String(data.nextAction)}`;
      break;
    case "attempt.process-death":
      sentence = `${who}'s runtime process died — the outcome stays unknown until reconciliation`;
      break;
    case "attempt.coordinator-retried":
      sentence = `the coordinator retried on fresh ${who} — durable evidence proved no dispatch`;
      break;
    case "run.halted":
      sentence = `run halted awaiting a human — the same failure repeated ${String(data.repeats)} times`;
      break;
    case "run.reconciliation.started":
      sentence = `run reconciliation began (from ${String(data.from)})`;
      break;
    case "run.reconciliation.resolved":
      sentence =
        typeof data.basis === "string"
          ? `run reconciliation resolved to ${String(data.to)}, citing the evidence it inspected`
          : `run reconciliation resolved to ${String(data.to)}`;
      break;
    case "attempt.reconciliation.started":
      sentence = `${who} reconciliation began (from ${String(data.from)})`;
      break;
    case "attempt.reconciliation.resolved":
      sentence =
        typeof data.basis === "string"
          ? `${who} reconciliation resolved to ${String(data.to)}, citing the evidence it inspected`
          : `${who} reconciliation resolved to ${String(data.to)}`;
      break;
    case "draft.saved":
      sentence = "a draft was saved — saving is not publication approval";
      break;
    case "publication.approved":
      sentence = "publication approved — one exact diff, spent once";
      break;
    case "publication.blocked":
      sentence = "publication blocked";
      break;
    case "publication.failed":
      sentence = `publication failed${reason ? ` (${reason})` : ""}`;
      break;
    case "publication.uncertain":
      sentence = "publication outcome unknown — reconcile before anything retries";
      break;
    case "publication.succeeded":
      sentence = "publication proven — the issue body reads back as approved";
      break;
    default:
      // Unknown kinds are evidence too: rendered as themselves, never
      // dropped, never invented into a known sentence.
      sentence = event.kind;
  }
  return { sentence, at: event.at, ...truncatedDetail(event.data) };
};

const segmentFor = (key: string, heading: string): TimelineSegment => ({
  key,
  heading,
  entries: [],
});

// The attempt numbering the whole projection shares: record order, 1-based.
const attemptNumbersFor = (
  attempts: ClarificationRunResult["attempts"],
): ReadonlyMap<string, number> =>
  new Map(attempts.map((attempt, index) => [attempt.attemptId, index + 1]));

export const timelineSegments = (
  section: Pick<ClarificationRunResult, "attempts" | "events" | "gap">,
): Timeline => {
  const attemptNumbers = attemptNumbersFor(section.attempts);
  const runSegment = segmentFor("run", "run");
  const byAttempt = new Map(
    section.attempts.map((attempt, index) => {
      const heading =
        attempt.origin === "coordinator-retry"
          ? `attempt ${index + 1} — the coordinator's evidence-gated retry`
          : `attempt ${index + 1}`;
      return [attempt.attemptId, segmentFor(attempt.attemptId, heading)];
    }),
  );

  for (const envelope of section.events) {
    const { event } = envelope;
    // The conversation commands (prompt, steer, queue, dialogs — and their
    // refusals) are the chat surface's rows: the timeline references the
    // conversation, it never duplicates it.
    if (event.type === "operational" && event.kind.startsWith("conversation.")) continue;
    let segment: TimelineSegment;
    if (event.type === "lifecycle")
      segment = event.scope === "run" ? runSegment : (byAttempt.get(event.id) ?? runSegment);
    else if (event.type === "conversation") segment = byAttempt.get(event.attemptId) ?? runSegment;
    else {
      const data = (event.data ?? {}) as Record<string, unknown>;
      segment =
        typeof data.attemptId === "string"
          ? (byAttempt.get(data.attemptId) ?? runSegment)
          : runSegment;
    }
    if (event.type === "conversation") {
      // One reference per segment, however many frames streamed.
      if (segment.entries.some((entry) => entry.reference)) continue;
      segment.entries.push({ cursor: envelope.cursor, sentence: "", reference: true });
      continue;
    }
    const { sentence, at, detail, detailTruncated, reference } = entryFor(envelope, attemptNumbers);
    segment.entries.push({
      cursor: envelope.cursor,
      sentence,
      ...(at !== undefined ? { at } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(detailTruncated ? { detailTruncated: true } : {}),
      ...(reference ? { reference: true } : {}),
    });
  }

  return {
    ...(section.gap
      ? {
          gapDivider: {
            hiddenCount: section.gap.firstRetainedCursor - section.gap.after - 1,
            firstRetainedCursor: section.gap.firstRetainedCursor,
          },
        }
      : {}),
    segments: [runSegment, ...byAttempt.values()],
  };
};

// --- The "Where you left off" return card.

export type ReturnCard = {
  reason: "gap" | "awaiting-human" | "reconciling";
  runState: string;
  attemptState: string | null;
  ownership: Ownership;
  lastTrustedEvent: { cursor: number; summary: string; at?: string } | null;
  missingDecision: string | null;
  primary: { label: string; action: "follow-live" | "review-timeline" };
};

// Rendered on reconnect-after-gap and whenever the run sits in
// awaiting-human or reconciling. Fixed fields from the operational record,
// and exactly one primary next safe action — never the destructive discard,
// which never leads anyone anywhere.
export const returnCard = (
  section: Pick<
    ClarificationRunResult,
    "run" | "attempts" | "events" | "gap" | "lease" | "escalations"
  >,
): ReturnCard | null => {
  const state = section.run.state;
  const reason =
    state === "awaiting-human"
      ? ("awaiting-human" as const)
      : state === "reconciling"
        ? ("reconciling" as const)
        : section.gap
          ? ("gap" as const)
          : null;
  if (reason === null) return null;

  const attemptNumbers = attemptNumbersFor(section.attempts);
  const last = section.events.at(-1);
  const lastSummary = last ? entryFor(last, attemptNumbers) : null;
  const lastTrustedEvent =
    last && lastSummary
      ? {
          cursor: last.cursor,
          summary: lastSummary.sentence,
          ...(lastSummary.at !== undefined ? { at: lastSummary.at } : {}),
        }
      : null;

  const newestEscalation = section.escalations?.at(-1);
  const missingDecision =
    newestEscalation?.decision ??
    (reason === "awaiting-human"
      ? "the run is parked awaiting a human decision"
      : reason === "reconciling"
        ? "a reconciliation is inspecting the record"
        : null);

  const primary =
    reason === "gap" && state === "active"
      ? { label: "Follow live", action: "follow-live" as const }
      : {
          label:
            reason === "awaiting-human"
              ? "Review the record and decide"
              : reason === "reconciling"
                ? "Inspect the reconciliation"
                : "Review the record",
          action: "review-timeline" as const,
        };

  return {
    reason,
    runState: state,
    attemptState: section.attempts.at(-1)?.state ?? null,
    ownership: ownershipFor(section.lease ?? null),
    lastTrustedEvent,
    missingDecision,
    primary,
  };
};

// The In flight chip's word: the newest non-terminal run for the issue, in
// the run lifecycle's own vocabulary. A terminal run is finished work, not
// in flight; the chip renders zero actions either way.
export const runChipFor = (
  runs: readonly ClarificationRunSummary[],
  issueId: string,
): string | null => {
  const candidates = runs.filter((run) => run.issueId === issueId && run.state !== "terminal");
  if (candidates.length === 0) return null;
  const newest = [...candidates].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.runId < b.runId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  )[0];
  return newest.state;
};

// The discard gate, mirrored from the store's own law (store.mjs
// DISCARDABLE_STATES, now exported): only the recovery states a stuck
// record can sit in hold discardable retained evidence. The store rejects
// anything else anyway — this mirror only decides whether the destructive
// control renders, and the drift fence in scripts/seam/clarification/
// store.test.mjs pins the two lists to each other.
export const DISCARDABLE_RUN_STATES: readonly string[] = [
  "unknown",
  "awaiting-human",
  "quarantined",
];

const discardableStates: ReadonlySet<string> = new Set(DISCARDABLE_RUN_STATES);

export const discardable = (run: Pick<ClarificationRunSnapshot, "state">): boolean =>
  discardableStates.has(run.state);
