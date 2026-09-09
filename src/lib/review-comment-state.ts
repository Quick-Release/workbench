import { parseReviewCommentResult } from "../schema";

// The post-as-comment action's states (ticket #25), as one discriminated
// union the action renders from, with the endpoint's response grammar kept
// pure so it is tested without a DOM — the draft panel's pattern (ticket
// #38). Nothing is ever sent without the confirming phase; the mapping only
// decides what an answer means. Seam payloads pass the Effect Schema
// boundary (ADR 0005), so the 200 path is schema-validated, not
// hand-checked.

export type ReviewCommentState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "posting" }
  | { phase: "posted"; message: string; commentUrl: string }
  | { phase: "error"; message: string };

export const idleState: ReviewCommentState = { phase: "idle" };
export const confirmingState: ReviewCommentState = { phase: "confirming" };
export const postingState: ReviewCommentState = { phase: "posting" };

// The response's wire shape, loosely typed on purpose: mapping, not
// validation, is this module's job; the wire may carry any keys. `remediation`
// is the runner's one-step fix and outclasses every generic wording.
export type CommentResponsePayload = {
  [key: string]: unknown;
  message?: unknown;
  commentUrl?: unknown;
  error?: unknown;
  remediation?: unknown;
} | null;

export const NETWORK_ERROR =
  "could not reach the comment endpoint — is `pnpm dev` running with the review middlewares loaded?";

export const UNPARSEABLE_RESPONSE = "the comment response was missing a link or a message";

export const mapCommentResponse = (status: number, payload: CommentResponsePayload) => {
  if (status === 0) return { phase: "error", message: NETWORK_ERROR } satisfies ReviewCommentState;
  if (status === 200) {
    try {
      const result = parseReviewCommentResult(payload);
      return {
        phase: "posted",
        message: result.message,
        commentUrl: result.commentUrl,
      } satisfies ReviewCommentState;
    } catch {
      return { phase: "error", message: UNPARSEABLE_RESPONSE } satisfies ReviewCommentState;
    }
  }
  const remediation = typeof payload?.remediation === "string" ? payload.remediation : null;
  if (remediation) return { phase: "error", message: remediation } satisfies ReviewCommentState;
  const code = typeof payload?.error === "string" ? payload.error : null;
  const message =
    typeof payload?.message === "string" && payload.message
      ? payload.message
      : code
        ? `${code} (HTTP ${status})`
        : `posting failed (HTTP ${status})`;
  return { phase: "error", message } satisfies ReviewCommentState;
};
