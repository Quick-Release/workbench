import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, expect, it } from "vite-plus/test";

import { reviewRunOutcome, runBusy, runEvent, runFailed, runStarted } from "./review-run-state";

// The review-run board (ticket #26): the lifecycle's state decisions as pure
// functions — a run is running, busy, or done, and every terminal state
// keeps what the Developer needs to see.

describe("the review-run board", () => {
  it("starts a run as running with the engine and PR", () => {
    const state = runStarted("coderabbit", 42, 1);
    strictEqual(state.phase, "running");
    strictEqual(state.engine, "coderabbit");
    strictEqual(state.pr, 42);
    strictEqual(state.output.length, 0);
  });

  it("appends streamed output and keeps its order", () => {
    let state = runStarted("zcode", 7, 2);
    state = runEvent(state, { type: "output", stream: "stdout", text: "finding one\n" });
    state = runEvent(state, { type: "output", stream: "stderr", text: "warn\n" });
    strictEqual(state.output, "finding one\nwarn\n");
    strictEqual(state.phase, "running");
  });

  it("finishes on the exit event, keeping the cancelled verdict", () => {
    let state = runStarted("coderabbit", 42, 1);
    state = runEvent(state, { type: "output", stream: "stdout", text: "partial\n" });
    state = runEvent(state, { type: "exit", code: null, signal: "SIGTERM", cancelled: true });
    strictEqual(state.phase, "done");
    strictEqual(state.exit?.cancelled, true);
    deepStrictEqual(
      state.exit,
      { code: null, signal: "SIGTERM", cancelled: true },
      "the exit verdict travels without the event discriminant",
    );
    strictEqual(state.output, "partial\n", "the run keeps its output");
  });

  it("marks truncation once the marker arrives", () => {
    let state = runStarted("coderabbit", 42, 1);
    state = runEvent(state, { type: "truncated" });
    strictEqual(state.truncated, true);
  });

  it("keeps the run un-restartable while the timeout error waits for its exit", () => {
    let state = runStarted("zcode", 7, 2);
    state = runEvent(state, {
      type: "error",
      reason: "timeout",
      message: "the zcode review exceeded 900s and was stopped",
    });
    strictEqual(state.phase, "running", "still stopping — not restartable yet");
    strictEqual(state.error?.reason, "timeout");
    state = runEvent(state, { type: "exit", code: null, signal: "SIGKILL", cancelled: false });
    strictEqual(state.phase, "done");
    strictEqual(state.error?.reason, "timeout", "the error survives the exit");
  });

  it("renders a busy rejection as a message, dropping the dead run", () => {
    let state = runStarted("coderabbit", 42, 1);
    state = runEvent(state, { type: "output", stream: "stdout", text: "partial\n" });
    state = runBusy(state, "a coderabbit review is already running");
    strictEqual(state.phase, "busy");
    strictEqual(state.busyMessage, "a coderabbit review is already running");
    strictEqual(state.output, "", "prior output is cleared with the dead run");
  });

  it("records an unreachable endpoint as a failure, not a hang", () => {
    let state = runStarted("zcode", 7, 2);
    state = runEvent(state, { type: "output", stream: "stdout", text: "partial\n" });
    state = runFailed(state, "the review endpoint is unreachable");
    strictEqual(state.phase, "done");
    strictEqual(state.failure, "the review endpoint is unreachable");
    strictEqual(state.output, "");
  });

  it("ignores events for a run that is already over", () => {
    let state = runStarted("coderabbit", 42, 1);
    state = runEvent(state, { type: "exit", code: 0, signal: null, cancelled: false });
    state = runEvent(state, { type: "output", stream: "stdout", text: "late\n" });
    expect(state.output).toBe("");
  });
});

describe("the issue-agent run board (issue #40)", () => {
  it("starts an agent run with its issue and model instead of a PR", () => {
    const state = runStarted("opencode", { issue: 40, model: "ollama/qwen3-coder:30b" }, 3);
    strictEqual(state.phase, "running");
    strictEqual(state.engine, "opencode");
    strictEqual(state.issue, 40);
    strictEqual(state.model, "ollama/qwen3-coder:30b");
    strictEqual(state.pr, null);
  });

  it("keeps notices apart from the raw stream", () => {
    let state = runStarted("opencode", { issue: 40 }, 4);
    state = runEvent(state, { type: "output", stream: "stdout", text: '{"type":"permission"}\n' });
    state = runEvent(state, { type: "notice", message: "agent permission event: permission" });
    state = runEvent(state, { type: "notice", message: "agent needs attention: question" });
    deepStrictEqual(state.notices, [
      "agent permission event: permission",
      "agent needs attention: question",
    ]);
    strictEqual(state.phase, "running");
  });

  it("a finished agent run grades by its exit like any run", () => {
    let state = runStarted("opencode", { issue: 40 }, 5);
    state = runEvent(state, { type: "exit", code: 0, signal: null, cancelled: false });
    strictEqual(state.phase, "done");
    strictEqual(reviewRunOutcome(state.exit, false), "completed");
  });
});
