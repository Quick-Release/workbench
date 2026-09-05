import type { TriageState, WorkflowPhase, WorkItemRecord } from "../types";

// The show-with-caveat vocabulary of the derivation contract (spec #54,
// "Wrong attribution renders show-with-caveat"): wrong attribution renders
// both facts — never hidden, never written back. The one wrong-attribution
// case that does not render a caveat line is two `workflow:` labels: per
// ADR 0007 those resolve to the furthest-along phase at record derivation
// (scripts/tracker/labels.mjs), whose warning is the caveat channel, so the
// record intentionally carries only the resolved phase.
export type DisplayCaveatKind =
  | "decision-ticket-phase"
  | "implementing-needs-info"
  | "shipped-open"
  | "grilling-wontfix"
  | "closed-without-shipped";

export type DisplayCaveat = {
  kind: DisplayCaveatKind;
  message: string;
};

export type DisplayState = {
  state: "open" | "closed";
  phase: WorkflowPhase | null;
  triageState: TriageState;
  deferred: boolean;
  claimed: boolean;
  blocked: boolean;
  caveats: DisplayCaveat[];
};

// Decision tickets (map children) carry no phase of their own — their phase
// derives from kind plus open/claimed state. A map itself carries phase like
// any issue (ADR 0007).
const isDecisionTicket = (workItem: WorkItemRecord) =>
  workItem.kind !== null && workItem.kind !== "map";

export const deriveDisplayState = (workItem: WorkItemRecord, blocked: boolean): DisplayState => {
  const caveats: DisplayCaveat[] = [];
  const { state, phase, triageState, deferred, assignees } = workItem;

  if (phase !== null && isDecisionTicket(workItem))
    caveats.push({
      kind: "decision-ticket-phase",
      message: `Phase "${phase}" sits on a decision ticket — ignored for flow math; the ticket's phase derives from its kind and open/claimed state.`,
    });

  if (phase === "implementing" && triageState === "needs-info")
    caveats.push({
      kind: "implementing-needs-info",
      message: `Phase "implementing" while the item waits on its reporter (needs-info) — both facts shown.`,
    });

  if (phase === "shipped" && state === "open")
    caveats.push({
      kind: "shipped-open",
      message: `Phase "shipped" but the issue is still open — both facts shown.`,
    });

  if (phase === "grilling" && triageState === "wontfix")
    caveats.push({
      kind: "grilling-wontfix",
      message: `Phase "grilling" on a refused (wontfix) item — both facts shown.`,
    });

  // Pre-flow closures are legitimate (triage refusal never wears a phase);
  // an item that entered the flow and closed without reaching shipped is
  // the accident this caveat exposes.
  if (state === "closed" && phase !== null && phase !== "shipped")
    caveats.push({
      kind: "closed-without-shipped",
      message: `Closed while phase is "${phase}" — closed without shipped.`,
    });

  return {
    state,
    phase: phase !== null && isDecisionTicket(workItem) ? null : phase,
    triageState,
    deferred,
    claimed: assignees.length > 0,
    blocked,
    caveats,
  };
};
