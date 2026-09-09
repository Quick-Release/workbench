// @vitest-environment happy-dom
import { strictEqual } from "node:assert";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { ReviewHistoryPanel } from "./ReviewHistoryPanel";
import type { ReviewHistoryEntry } from "../types";

// Ticket #27's UI contract: the session's finished runs list newest first
// with engine, PR, outcome, and duration; a run's streamed result re-opens
// without re-running it; and the re-run action starts a fresh run through
// the page's normal lifecycle.

const entry = (overrides: Partial<ReviewHistoryEntry> = {}): ReviewHistoryEntry => ({
  id: 1,
  engine: "coderabbit",
  pr: 42,
  outcome: "completed",
  durationMs: 4200,
  output: "finding one\nfinding two\n",
  truncated: false,
  message: null,
  ...overrides,
});

const renderPanel = (
  history: readonly ReviewHistoryEntry[] | null,
  onRerun: (entry: ReviewHistoryEntry) => void = () => {},
) => renderToString(<ReviewHistoryPanel history={history} onRerun={onRerun} />);

describe("the session run history panel", () => {
  it("renders nothing while the session history is still loading", () => {
    expect(renderPanel(null)).toBe("");
  });

  it("answers an empty session with its own empty state", () => {
    const html = renderPanel([]);
    expect(html).toContain('data-slot="review-history-empty"');
    expect(html).toContain("No reviews yet in this dashboard session.");
  });

  it("lists each finished run with engine, pr, outcome, and duration", () => {
    // SSR splices comment markers between adjacent text nodes; normalize
    // before asserting on visible text.
    const html = renderPanel([
      entry(),
      entry({ id: 2, engine: "zcode", pr: 43, outcome: "cancelled", durationMs: 250 }),
    ]).replaceAll("<!-- -->", "");
    expect(html).toContain('data-history-entry="1"');
    expect(html).toContain("coderabbit");
    expect(html).toContain("#42");
    expect(html).toContain("completed");
    expect(html).toContain("4.2s");
    expect(html).toContain('data-history-entry="2"');
    expect(html).toContain("cancelled");
    expect(html).toContain("250ms");
  });

  it("flags a truncated run's history entry", () => {
    const html = renderPanel([entry({ truncated: true })]);
    expect(html).toContain("truncated");
  });

  it("re-opens a run's streamed result without re-running it", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onRerun = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ReviewHistoryPanel history={[entry()]} onRerun={onRerun} />);
    });

    expect(container.innerHTML).not.toContain("finding one");
    const open = container.querySelector<HTMLButtonElement>('button[data-history-open="1"]');
    expect(open).toBeTruthy();
    await act(async () => {
      open?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const output = container.querySelector('[data-history-output="1"]');
    expect(output?.textContent).toContain("finding one\nfinding two\n");
    strictEqual(onRerun.mock.calls.length, 0, "re-opening never re-runs");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("re-runs an entry through the page's normal start path", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onRerun = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ReviewHistoryPanel
          history={[entry({ id: 7, engine: "zcode", pr: 43 })]}
          onRerun={onRerun}
        />,
      );
    });

    const rerun = container.querySelector<HTMLButtonElement>('button[data-history-rerun="7"]');
    expect(rerun).toBeTruthy();
    await act(async () => {
      rerun?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onRerun).toHaveBeenCalledWith(expect.objectContaining({ pr: 43, engine: "zcode" }));
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe("issue runs in the history (issue #40)", () => {
  it("labels an issue entry by its issue, not a PR number", () => {
    const html = renderPanel([
      entry({
        id: 9,
        engine: "opencode",
        pr: null,
        issue: 40,
        output: "reading the issue\n",
      }),
    ]).replaceAll("<!-- -->", "");
    expect(html).toContain('data-history-entry="9"');
    expect(html).toContain("opencode");
    expect(html).toContain("#40");
    expect(html).not.toContain("#null");
  });

  it("re-runs an issue entry with the whole entry, issue included", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onRerun = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const issueEntry = entry({ id: 11, engine: "opencode", pr: null, issue: 40 });
    await act(async () => {
      root.render(<ReviewHistoryPanel history={[issueEntry]} onRerun={onRerun} />);
    });

    const rerun = container.querySelector<HTMLButtonElement>('button[data-history-rerun="11"]');
    expect(rerun).toBeTruthy();
    await act(async () => {
      rerun?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onRerun).toHaveBeenCalledWith(expect.objectContaining({ issue: 40, pr: null }));
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
