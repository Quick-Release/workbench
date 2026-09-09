// @vitest-environment happy-dom
import { strictEqual } from "node:assert";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { IssueAgentPanel } from "./IssueAgentPanel";
import { emptyReviewRun, runBusy, runEvent, runFailed, runStarted } from "@/lib/review-run-state";
import type { ReviewEngineHealth } from "../types";

// The issue-agent panel's contract (issue #40): one card that takes an issue
// number and a model from the health report, starts a run, and renders the
// same typed event stream the review panel does — notices included. The
// start affordance exists only when the engine's health said ready.

const ready: ReviewEngineHealth = {
  engine: "opencode",
  state: "ready",
  version: "opencode 1.0.197",
  models: ["qwen3-coder:30b", "llama3.2:latest"],
  defaultModel: "ollama/qwen3-coder:30b",
};

const renderPanel = ({
  health = ready as ReviewEngineHealth | null,
  run = emptyReviewRun,
  onStart = () => {},
  onCancel = () => {},
} = {}) =>
  // React SSR sprinkles comment markers between interpolations; strip them
  // so text assertions read as one string.
  renderToString(
    <IssueAgentPanel health={health} run={run} onStart={onStart} onCancel={onCancel} />,
  ).replaceAll("<!-- -->", "");

describe("the issue-agent panel", () => {
  it("renders the launcher with an issue input and a model picker from health", () => {
    const html = renderPanel();
    expect(html).toContain('data-slot="issue-agent-input"');
    expect(html).toContain('data-slot="issue-agent-model"');
    expect(html).toContain('value="qwen3-coder:30b"');
    expect(html).toContain('value="llama3.2:latest"');
    expect(html).toContain("qwen3-coder:30b"); // the default model is preselected
  });

  it("disables starting while the engine is unknown or not ready", () => {
    expect(renderPanel({ health: null })).toContain("disabled");
    expect(
      renderPanel({
        health: {
          engine: "opencode",
          state: "ollama_unreachable",
          version: "opencode 1.0.197",
          remediation:
            "start the Ollama server (`ollama serve`) — the issue agent runs local models only",
        },
      }),
    ).toContain("start the Ollama server");
  });

  it("shows the context-length warning on an otherwise-ready engine", () => {
    const html = renderPanel({
      health: { ...ready, warning: "Ollama is using its small default context (4096 tokens)." },
    });
    expect(html).toContain("4096 tokens");
  });

  it("a running agent run streams output, notices, and a cancel affordance", () => {
    let run = runStarted("opencode", { issue: 40, model: "ollama/qwen3-coder:30b" }, 1);
    run = runEvent(run, { type: "output", stream: "stdout", text: "reading issue\n" });
    run = runEvent(run, { type: "notice", message: "agent permission event: permission" });
    const html = renderPanel({ run });
    expect(html).toContain("issue #40");
    expect(html).toContain("reading issue");
    expect(html).toContain('data-slot="issue-agent-notice"');
    expect(html).toContain("agent permission event: permission");
    expect(html).toContain('data-slot="issue-agent-cancel"');
  });

  it("a busy or failed run renders the server's message", () => {
    const busy = runBusy(
      runStarted("opencode", { issue: 40 }, 2),
      "an opencode run is already running; cancel it or wait for it to finish",
    );
    expect(renderPanel({ run: busy })).toContain("already running");
    const failed = runFailed(
      runStarted("opencode", { issue: 40 }, 3),
      "the endpoint is unreachable",
    );
    expect(renderPanel({ run: failed })).toContain("the endpoint is unreachable");
  });

  it("a finished run announces the draft PR verdict", () => {
    let run = runStarted("opencode", { issue: 40 }, 4);
    run = runEvent(run, { type: "exit", code: 0, signal: null, cancelled: false });
    const html = renderPanel({ run });
    expect(html).toContain('data-slot="issue-agent-verdict"');
    expect(html).toContain("Draft pull request");
  });
});

describe("the issue-agent panel's start request (issue #40)", () => {
  it("sends an ollama-qualified model id, the form the seam validates", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onStart = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <IssueAgentPanel
          health={ready}
          run={emptyReviewRun}
          onStart={onStart}
          onCancel={() => {}}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[data-slot="issue-agent-input"]');
    const picker = container.querySelector<HTMLSelectElement>(
      'select[data-slot="issue-agent-model"]',
    );
    expect(input).toBeTruthy();
    expect(picker).toBeTruthy();
    if (input) input.value = "40";
    if (picker) picker.value = "llama3.2:latest";
    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    strictEqual(onStart.mock.calls.length, 1);
    strictEqual(onStart.mock.calls[0][0], 40);
    strictEqual(
      onStart.mock.calls[0][1],
      "ollama/llama3.2:latest",
      "the bare /api/tags name is qualified for the seam",
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
