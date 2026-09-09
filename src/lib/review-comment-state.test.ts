import { describe, expect, it } from "vite-plus/test";

import { NETWORK_ERROR, UNPARSEABLE_RESPONSE, mapCommentResponse } from "./review-comment-state";

// The post-as-comment action's response grammar (ticket #25), kept pure so
// it is tested without a DOM: 200 is a posted comment (schema-validated,
// ADR 0005); a failure carrying a `remediation` is the environment's
// one-step fix and becomes the message the Developer acts on; everything
// else is a readable error.

const posted = {
  message: "Review findings posted to PR #25.",
  engine: "coderabbit",
  pr: 25,
  commentUrl: "https://github.com/Quick-Release/workbench/pull/25#issuecomment-9",
};

describe("mapping the comment endpoint's response", () => {
  it("reads a 200 as a posted comment with its link", () => {
    const state = mapCommentResponse(200, posted);
    expect(state).toEqual({
      phase: "posted",
      message: "Review findings posted to PR #25.",
      commentUrl: "https://github.com/Quick-Release/workbench/pull/25#issuecomment-9",
    });
  });

  it("reads a 200 that violates the seam shape as an error, not a linkless success", () => {
    const state = mapCommentResponse(200, { message: "posted", pr: 25 });
    expect(state.phase).toBe("error");
    expect(state.message).toBe(UNPARSEABLE_RESPONSE);
  });

  it("prefers a failure's remediation — it is the one-step fix", () => {
    const state = mapCommentResponse(422, {
      error: "gh_auth_missing",
      remediation: "run `gh auth login` to authenticate the GitHub CLI",
    });
    expect(state).toEqual({
      phase: "error",
      message: "run `gh auth login` to authenticate the GitHub CLI",
    });
  });

  it("falls back to the failure's message, then its error name", () => {
    expect(mapCommentResponse(502, { error: "post_failed", message: "gh exploded" })).toEqual({
      phase: "error",
      message: "gh exploded",
    });
    expect(mapCommentResponse(502, { error: "post_failed" })).toEqual({
      phase: "error",
      message: "post_failed (HTTP 502)",
    });
    expect(mapCommentResponse(500, {})).toEqual({
      phase: "error",
      message: "posting failed (HTTP 500)",
    });
  });

  it("reads an unreachable endpoint as its own error", () => {
    expect(mapCommentResponse(0, null)).toEqual({ phase: "error", message: NETWORK_ERROR });
  });
});
