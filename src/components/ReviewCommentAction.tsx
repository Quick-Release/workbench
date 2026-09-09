import { useState } from "react";

import {
  confirmingState,
  idleState,
  mapCommentResponse,
  postingState,
  type CommentResponsePayload,
} from "../lib/review-comment-state";
import type { ReviewEngine } from "../types";

// The post-as-comment action (epic #20, ticket #25): a completed review's
// findings, offered to the Developer as one GitHub comment on the reviewed
// PR. Nothing is ever sent without the explicit confirmation beat —
// cancelling unwinds to idle and the endpoint is never called — and the
// posted comment is the Developer's own, through their local `gh`
// credentials. The fetch stays a literal /api/ call at its use (ADR 0005);
// the response grammar lives in the pure state mapper.

export function ReviewCommentAction({
  engine,
  pr,
  findings,
}: {
  engine: ReviewEngine;
  pr: number;
  findings: string;
}) {
  const [state, setState] = useState(idleState);

  const post = async () => {
    setState(postingState);
    let status = 0;
    let payload: CommentResponsePayload = null;
    try {
      const response = await fetch("/api/review/comment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine, pr, findings }),
      });
      status = response.status;
      payload = await response.json();
    } catch {
      payload = null;
    }
    setState(mapCommentResponse(status, payload));
  };

  return (
    <div data-slot="review-comment-action" data-review-comment-state={state.phase}>
      {state.phase === "idle" && (
        <button
          type="button"
          data-review-comment-action="post"
          className="text-xs text-muted-foreground underline underline-offset-2"
          onClick={() => setState(confirmingState)}
        >
          Post as PR comment
        </button>
      )}
      {state.phase === "confirming" && (
        <div data-slot="review-comment-confirm" className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Post these findings to PR #{pr} as a GitHub comment, from your own `gh` credentials?
            Nothing is posted without this confirmation.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              data-review-comment-action="confirm-post"
              className="text-xs underline underline-offset-2"
              onClick={post}
            >
              Post comment
            </button>
            <button
              type="button"
              data-review-comment-action="cancel"
              className="text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => setState(idleState)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {state.phase === "posting" && (
        <p className="text-xs text-muted-foreground" aria-busy="true">
          Posting…
        </p>
      )}
      {state.phase === "posted" && (
        <p data-slot="review-comment-posted" className="text-xs text-muted-foreground">
          {state.message}{" "}
          <a
            href={state.commentUrl}
            data-review-comment-link
            className="underline underline-offset-2"
          >
            View the comment
          </a>
        </p>
      )}
      {state.phase === "error" && (
        <div data-slot="review-comment-error" className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{state.message}</p>
          <button
            type="button"
            data-review-comment-action="retry"
            className="text-xs text-left underline underline-offset-2"
            onClick={() => setState(confirmingState)}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
