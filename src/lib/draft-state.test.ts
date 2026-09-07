import { describe, expect, it } from "vite-plus/test";

import {
  boardState,
  emptyBoard,
  failDraft,
  idleState,
  mapDraftResponse,
  NETWORK_ERROR,
  resolveDraft,
  startDraft,
  unconfiguredState,
} from "./draft-state";

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

  it("falls back to the error code, then a plain fallback, when no message rides along", () => {
    expect(mapDraftResponse(502, { error: "provider_error" })).toEqual({
      phase: "error",
      message: "provider_error (HTTP 502)",
    });
    expect(mapDraftResponse(400, null)).toEqual({
      phase: "error",
      message: "drafting failed (HTTP 400)",
    });
  });

  it("diagnoses a 200 that carries no JSON as an unreachable middleware", () => {
    expect(mapDraftResponse(200, null)).toEqual({ phase: "error", message: NETWORK_ERROR });
  });

  it("does not trust a 200 payload missing its title or body", () => {
    expect(mapDraftResponse(200, { title: "only a title" })).toEqual({
      phase: "error",
      message: "the draft response was missing a title or body",
    });
  });

  it("exposes the shared idle and drafting states", () => {
    expect(idleState).toEqual({ phase: "idle" });
    expect(unconfiguredState).toEqual({ phase: "unconfigured" });
  });
});

describe("the draft board's no-clobber rule", () => {
  it("starts idle: rows read as idle until a draft starts", () => {
    expect(boardState(emptyBoard, 82)).toEqual(idleState);
  });

  it("marks the started row drafting and retires the row it displaces", () => {
    const first = startDraft(emptyBoard, 82);
    expect(boardState(first, 82)).toEqual({ phase: "drafting" });
    expect(first.inFlight).toBe(82);

    const second = startDraft(first, 78);
    expect(boardState(second, 82)).toEqual(idleState);
    expect(boardState(second, 78)).toEqual({ phase: "drafting" });
    expect(second.inFlight).toBe(78);
    expect(second.token).toBe(first.token + 1);
  });

  it("applies a response that carries the current token", () => {
    const started = startDraft(emptyBoard, 82);
    const resolved = resolveDraft(started, 82, started.token, 200, {
      title: "The title",
      body: "The body",
    });
    expect(boardState(resolved, 82)).toEqual({
      phase: "done",
      title: "The title",
      body: "The body",
    });
    expect(resolved.inFlight).toBeNull();
  });

  it("drops a stale response so it never clobbers the newer panel", () => {
    const first = startDraft(emptyBoard, 82);
    const second = startDraft(first, 78);
    // The displaced request's late 200 arrives after its row was retired
    // and a newer draft started: token stale, board unchanged.
    const late = resolveDraft(second, 82, first.token, 200, {
      title: "Stale",
      body: "Stale",
    });
    expect(late).toBe(second);
    // Same for a same-row restart: the older request's resolution is stale.
    const restarted = startDraft(second, 78);
    const lateSameRow = resolveDraft(restarted, 78, second.token, 200, {
      title: "Stale",
      body: "Stale",
    });
    expect(lateSameRow).toBe(restarted);
    expect(boardState(lateSameRow, 78)).toEqual({ phase: "drafting" });
  });

  it("drops a stale failure the same way, and applies a current one", () => {
    const started = startDraft(emptyBoard, 82);
    const restarted = startDraft(started, 82);
    expect(failDraft(restarted, 82, started.token, "old failure")).toBe(restarted);

    const failed = failDraft(restarted, 82, restarted.token, "the provider rejected the call");
    expect(boardState(failed, 82)).toEqual({
      phase: "error",
      message: "the provider rejected the call",
    });
  });
});
