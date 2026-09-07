// The draft panel's states (ticket #38), as one discriminated union the
// panel renders from and the container produces. The response mapping is
// the endpoint grammar from ticket #37 — status in, panel state out — kept
// pure so the abort-prone fetch wiring stays thin enough to read at a
// glance: 200 is a done draft, 503 is the not-configured hint, everything
// else is a readable error.

export type DraftState =
  | { phase: "idle" }
  | { phase: "drafting" }
  | { phase: "done"; title: string; body: string }
  | { phase: "error"; message: string }
  | { phase: "unconfigured" };

export const idleState: DraftState = { phase: "idle" };
export const draftingState: DraftState = { phase: "drafting" };
export const unconfiguredState: DraftState = { phase: "unconfigured" };

export const mapDraftResponse = (
  status: number,
  payload: { title?: unknown; body?: unknown; message?: unknown; error?: unknown } | null,
): DraftState => {
  if (status === 200) {
    if (typeof payload?.title === "string" && typeof payload?.body === "string") {
      return { phase: "done", title: payload.title, body: payload.body };
    }
    return { phase: "error", message: "the draft response was missing a title or body" };
  }
  if (status === 503) return unconfiguredState;
  const fallback = `drafting failed (HTTP ${status})`;
  const message =
    typeof payload?.message === "string" && payload.message ? payload.message : fallback;
  return { phase: "error", message };
};
