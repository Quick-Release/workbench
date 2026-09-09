import type { ReviewRunEvent } from "@/schema";
import type { ReviewEngine } from "@/types";

// The pure half of the review-run UI (ticket #26): every state decision a
// run's lifecycle goes through, as functions over plain data — the same
// board pattern as the draft state. The container fires the fetches and
// hands events in; nothing here touches the network.

export type ReviewRunPhase = "idle" | "running" | "busy" | "done";

export type ReviewRunState = {
  phase: ReviewRunPhase;
  engine: ReviewEngine | null;
  pr: number | null;
  output: string[];
  truncated: boolean;
  exit: { code: number | null; signal: string | null; cancelled: boolean } | null;
  error: { reason: string; message: string } | null;
  busyMessage: string | null;
  failure: string | null;
};

export const emptyReviewRun: ReviewRunState = {
  phase: "idle",
  engine: null,
  pr: null,
  output: [],
  truncated: false,
  exit: null,
  error: null,
  busyMessage: null,
  failure: null,
};

export const runStarted = (engine: ReviewEngine, pr: number): ReviewRunState => ({
  ...emptyReviewRun,
  phase: "running",
  engine,
  pr,
});

export const runEvent = (state: ReviewRunState, event: ReviewRunEvent): ReviewRunState => {
  if (state.phase !== "running") return state;
  switch (event.type) {
    case "started":
      return state;
    case "output":
      return { ...state, output: [...state.output, event.text] };
    case "truncated":
      return { ...state, truncated: true };
    case "exit":
      return { ...state, phase: "done", exit: { ...event } };
    case "error":
      return { ...state, phase: "done", error: { reason: event.reason, message: event.message } };
  }
};

export const runBusy = (state: ReviewRunState, message: string): ReviewRunState => ({
  ...state,
  phase: "busy",
  output: [],
  truncated: false,
  exit: null,
  error: null,
  failure: null,
  busyMessage: message,
});

export const runFailed = (state: ReviewRunState, failure: string): ReviewRunState => ({
  ...state,
  phase: "done",
  output: [],
  truncated: false,
  exit: null,
  error: null,
  busyMessage: null,
  failure,
});
