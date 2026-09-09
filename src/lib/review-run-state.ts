import type { ReviewRunEvent } from "@/schema";
import type { Engine } from "@/types";

// The pure half of the run UI (ticket #26; issue #40): every state decision
// a run's lifecycle goes through, as functions over plain data — the same
// board pattern as the draft state. The container fires the fetches and
// hands events in; nothing here touches the network. A run's target is a PR
// for the review engines or an issue (with an optional model) for the agent.

export type ReviewRunPhase = "idle" | "running" | "busy" | "done";

export type ReviewRunState = {
  phase: ReviewRunPhase;
  // Identifies the run a state belongs to: the page holds one run at a time,
  // but the server allows one per engine — a second engine's start must not
  // inherit the first engine's in-flight events.
  token: number;
  engine: Engine | null;
  pr: number | null;
  issue: number | null;
  model: string | null;
  output: string;
  truncated: boolean;
  // States the agent's stream inspector surfaced (permission denials,
  // confirmation-like stalls) — the signal between the raw JSON and the run.
  notices: string[];
  exit: { code: number | null; signal: string | null; cancelled: boolean } | null;
  error: { reason: string; message: string } | null;
  busyMessage: string | null;
  failure: string | null;
  // A failed cancellation keeps the run running and retryable, so the panel
  // never freezes with the Cancel affordance gone.
  cancelError: string | null;
};

export const emptyReviewRun: ReviewRunState = {
  phase: "idle",
  token: 0,
  engine: null,
  pr: null,
  issue: null,
  model: null,
  output: "",
  truncated: false,
  notices: [],
  exit: null,
  error: null,
  busyMessage: null,
  failure: null,
  cancelError: null,
};

export type RunTarget = number | { issue: number; model?: string };

export const runStarted = (engine: Engine, target: RunTarget, token: number): ReviewRunState => ({
  ...emptyReviewRun,
  phase: "running",
  token,
  engine,
  ...(typeof target === "number"
    ? { pr: target }
    : { issue: target.issue, model: target.model ?? null }),
});

export const runEvent = (state: ReviewRunState, event: ReviewRunEvent): ReviewRunState => {
  if (state.phase !== "running") return state;
  switch (event.type) {
    case "started":
      return state;
    case "output":
      return { ...state, output: state.output + event.text };
    case "truncated":
      return { ...state, truncated: true };
    case "notice":
      return { ...state, notices: [...state.notices, event.message] };
    case "exit": {
      const { code, signal, cancelled } = event;
      return { ...state, phase: "done", exit: { code, signal, cancelled } };
    }
    case "error":
      // The error precedes the exit while the CLI is being stopped: the run
      // stays running (and un-restartable) until the exit actually lands.
      return { ...state, error: { reason: event.reason, message: event.message } };
  }
};

export const runBusy = (state: ReviewRunState, message: string): ReviewRunState => ({
  ...state,
  phase: "busy",
  output: "",
  truncated: false,
  exit: null,
  error: null,
  failure: null,
  busyMessage: message,
});

export const runFailed = (state: ReviewRunState, failure: string): ReviewRunState => ({
  ...state,
  phase: "done",
  output: "",
  truncated: false,
  exit: null,
  error: null,
  busyMessage: null,
  cancelError: null,
  failure,
});

export const runCancelFailed = (state: ReviewRunState, message: string): ReviewRunState =>
  state.phase === "running" ? { ...state, cancelError: message } : state;

// The one place a finished run's verdict is named (ticket #27): a timeout's
// SIGKILL exit reads as timed out — the failure-ish exit code is the
// timeout's consequence, not a separate verdict — a cancelled exit reads as
// cancelled, and everything else grades by exit code. Both sides of the seam
// (the recording endpoint and the panel) classify from here.
export const reviewRunOutcome = (
  exit: { code: number | null; cancelled: boolean } | null,
  timedOut: boolean,
): "completed" | "failed" | "cancelled" | "timed_out" => {
  if (timedOut) return "timed_out";
  if (exit?.cancelled) return "cancelled";
  return exit && exit.code === 0 ? "completed" : "failed";
};
