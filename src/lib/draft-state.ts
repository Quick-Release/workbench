import { parseAiDraftResult } from "../schema";

// The draft panel's states (ticket #38), as one discriminated union the
// panel renders from and the container produces. The response mapping is
// the endpoint grammar from ticket #37 — status in, panel state out — kept
// pure so the abort-prone fetch wiring stays thin enough to read at a
// glance: 200 is a done draft, 503 is the not-configured hint, everything
// else is a readable error. Seam payloads pass the Effect Schema boundary
// (ADR 0005), so the 200 path is schema-validated, not hand-checked.

export type DraftState =
  | { phase: "idle" }
  | { phase: "drafting" }
  | { phase: "done"; title: string; body: string }
  | { phase: "error"; message: string }
  | { phase: "unconfigured" };

export const idleState: DraftState = { phase: "idle" };
export const draftingState: DraftState = { phase: "drafting" };
export const unconfiguredState: DraftState = { phase: "unconfigured" };

// The response's wire shape, loosely typed on purpose: mapping, not
// validation, is this module's job; `error` surfaces in the fallback
// message when the endpoint names a failure without a message.
export type AiDraftPayload = {
  title?: unknown;
  body?: unknown;
  message?: unknown;
  error?: unknown;
} | null;

export const NETWORK_ERROR =
  "could not reach the draft endpoint — is `pnpm dev` running with the AI middleware loaded?";

const UNPARSEABLE_200 = "the draft response was missing a title or body";

export const mapDraftResponse = (status: number, payload: AiDraftPayload): DraftState => {
  if (status === 200) {
    if (payload === null) return { phase: "error", message: NETWORK_ERROR };
    try {
      const result = parseAiDraftResult(payload);
      return { phase: "done", title: result.title, body: result.body };
    } catch {
      return { phase: "error", message: UNPARSEABLE_200 };
    }
  }
  if (status === 503) return unconfiguredState;
  const code = typeof payload?.error === "string" ? payload.error : null;
  const message =
    typeof payload?.message === "string" && payload.message
      ? payload.message
      : code
        ? `${code} (HTTP ${status})`
        : `drafting failed (HTTP ${status})`;
  return { phase: "error", message };
};

// The board is the page's whole draft state: which row shows what, which
// row has a request in flight, and the token of the latest start. The
// token is the no-clobber rule the spec demands: every response carries
// the token of the start that produced it and applies only while it is
// still current — an aborted or late arrival can never overwrite the
// newer panel. Pure, so that rule is tested without a DOM.

export type DraftBoard = {
  states: Record<number, DraftState>;
  inFlight: number | null;
  token: number;
};

export const emptyBoard: DraftBoard = { states: {}, inFlight: null, token: 0 };

export const boardState = (board: DraftBoard, pr: number): DraftState =>
  board.states[pr] ?? idleState;

export const startDraft = (board: DraftBoard, pr: number): DraftBoard => {
  const states = { ...board.states };
  if (board.inFlight !== null && board.inFlight !== pr) {
    // Starting another draft retires the row it displaces; the displaced
    // request's response is stale by token and drops on arrival.
    states[board.inFlight] = idleState;
  }
  states[pr] = draftingState;
  return { states, inFlight: pr, token: board.token + 1 };
};

export const resolveDraft = (
  board: DraftBoard,
  pr: number,
  token: number,
  status: number,
  payload: AiDraftPayload,
): DraftBoard => {
  if (board.token !== token) return board;
  return {
    states: { ...board.states, [pr]: mapDraftResponse(status, payload) },
    inFlight: null,
    token,
  };
};

export const failDraft = (
  board: DraftBoard,
  pr: number,
  token: number,
  message: string,
): DraftBoard => {
  if (board.token !== token) return board;
  return {
    states: { ...board.states, [pr]: { phase: "error", message } },
    inFlight: null,
    token,
  };
};
