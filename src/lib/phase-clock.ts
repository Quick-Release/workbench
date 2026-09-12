import type { WorkItemRecord } from "../types";

// GH-149: time-in-phase. The clock's only source is GitHub's own label-event
// history — the latest `labeled` event for the resolved phase's label, so
// re-entering a phase resets the clock — never a second store of phase
// history. The derivations are pure: the collector hands over wire events,
// the board hands over a record and a read time.

// The slice of GitHub's issue-events wire shape the clock reads. Everything
// optional: malformed entries are skipped, never guessed from.
export type IssueEvent = {
  event?: string;
  label?: { name?: string };
  created_at?: string;
};

export const phaseSinceFromEvents = (
  events: readonly IssueEvent[] | undefined,
  label: string,
): string | null => {
  let latest: number | null = null;
  for (const entry of events ?? []) {
    if (entry?.event !== "labeled" || entry.label?.name !== label) continue;
    const at = Date.parse(entry.created_at ?? "");
    if (Number.isNaN(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
};

// A card's clock line: "4d in implementing" off the event-derived clock, or —
// never posing as time in phase — "last touched 3h ago" where no clock exists
// (a failed read, or an older snapshot). Decision tickets and pre-flow items
// show no clock at all: they place without a phase, so any duration would be
// fabricated.
export type PhaseClockLine = {
  text: string;
  source: "phase" | "last-touched";
};

const durationText = (age: number) => {
  if (age < 60_000) return "just now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  return `${Math.floor(age / 86_400_000)}d`;
};

// Which records a clock may exist for at all (docs/agents/workflow-labels.md):
// decision tickets place by the board-placement table and carry no phase —
// only a map or a plain work item with a resolved phase can be clocked. The
// collector walks exactly these records and the display rule reads the same
// predicate, so the rule has one home.
export const phaseClockable = (record: WorkItemRecord): boolean =>
  (record.kind === null || record.kind === "map") && record.phase !== null;

export const phaseClockLine = (record: WorkItemRecord, now: number): PhaseClockLine | null => {
  if (!phaseClockable(record)) return null;
  const since = record.phaseSince === undefined ? NaN : Date.parse(record.phaseSince);
  if (!Number.isNaN(since))
    return {
      text: `${durationText(Math.max(0, now - since))} in ${record.phase}`,
      source: "phase",
    };
  const touched = record.updatedAt === undefined ? NaN : Date.parse(record.updatedAt);
  if (!Number.isNaN(touched))
    return {
      text: `last touched ${durationText(Math.max(0, now - touched))} ago`,
      source: "last-touched",
    };
  return null;
};
