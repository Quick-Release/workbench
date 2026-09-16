// Types for phase-clock.mjs (GH-195): the implementation is plain ESM so the
// installed CLI's raw-Node sync can import it from node_modules.
import type { WorkItemRecord } from "../types";

// The slice of GitHub's issue-events wire shape the clock reads. Everything
// optional: malformed entries are skipped, never guessed from.
export type IssueEvent = {
  event?: string;
  label?: { name?: string };
  created_at?: string;
};

export declare const phaseSinceFromEvents: (
  events: readonly IssueEvent[] | undefined,
  label: string,
) => string | null;

export type PhaseClockLine = {
  text: string;
  source: "phase" | "last-touched";
};

export declare const phaseClockable: (record: WorkItemRecord) => boolean;
export declare const phaseClockLine: (record: WorkItemRecord, now: number) => PhaseClockLine | null;
