import { describe, expect, it } from "vite-plus/test";

import { draftingState, idleState, mapDraftResponse, unconfiguredState } from "./draft-state";

describe("the draft response mapping", () => {
  it("lands a 200 with a title and body in the done state", () => {
    expect(mapDraftResponse(200, { title: "The title", body: "The body" })).toEqual({
      phase: "done",
      title: "The title",
      body: "The body",
    });
  });

  it("maps the endpoint's not-configured status to the hint state", () => {
    expect(mapDraftResponse(503, { error: "not_configured", message: "ignored" })).toEqual(
      unconfiguredState,
    );
  });

  it("carries the endpoint's readable message into the error state", () => {
    expect(
      mapDraftResponse(502, {
        error: "provider_error",
        message: "the provider rejected the call",
      }),
    ).toEqual({ phase: "error", message: "the provider rejected the call" });
  });

  it("falls back to a readable message when the payload carries none", () => {
    expect(mapDraftResponse(400, null)).toEqual({
      phase: "error",
      message: "drafting failed (HTTP 400)",
    });
    expect(mapDraftResponse(502, { error: "provider_error" })).toEqual({
      phase: "error",
      message: "drafting failed (HTTP 502)",
    });
  });

  it("does not trust a 200 payload missing its title or body", () => {
    expect(mapDraftResponse(200, { title: "only a title" })).toEqual({
      phase: "error",
      message: "the draft response was missing a title or body",
    });
  });

  it("exposes the shared idle and drafting states", () => {
    expect(idleState).toEqual({ phase: "idle" });
    expect(draftingState).toEqual({ phase: "drafting" });
  });
});
