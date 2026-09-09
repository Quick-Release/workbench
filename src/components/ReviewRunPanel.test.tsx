import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ReviewRunPanel } from "./ReviewRunPanel";
import { emptyReviewRun, runEvent, runStarted, runBusy } from "@/lib/review-run-state";

// The review-run panel's contract (ticket #26): a running run streams its
// output with a cancel affordance, a busy rejection renders the server's
// message, and a finished run keeps its output with its verdict — including
// the truncation marker. Nothing renders while idle.

describe("the review-run panel", () => {
  it("renders nothing while idle", () => {
    expect(renderToString(<ReviewRunPanel run={emptyReviewRun} />)).not.toContain(
      'data-slot="review-run"',
    );
  });

  it("renders a running run with its output and a cancel affordance", () => {
    let run = runStarted("coderabbit", 42, 1);
    run = runEvent(run, { type: "output", stream: "stdout", text: "finding one\n" });
    const html = renderToString(<ReviewRunPanel run={run} onCancel={() => {}} />);
    expect(html).toContain('data-run-phase="running"');
    expect(html).toContain("finding one");
    expect(html).toContain("Cancel");
  });

  it("renders a busy rejection as the server's message", () => {
    const run = runBusy(runStarted("coderabbit", 42, 1), "a coderabbit review is already running");
    const html = renderToString(<ReviewRunPanel run={run} />);
    expect(html).toContain('data-slot="review-run-busy"');
    expect(html).toContain("a coderabbit review is already running");
    expect(html).not.toContain("Cancel");
  });

  it("renders a finished run with its verdict, truncation, and no cancel", () => {
    let run = runStarted("zcode", 7, 2);
    run = runEvent(run, { type: "output", stream: "stdout", text: "looks fine\n" });
    run = runEvent(run, { type: "truncated" });
    run = runEvent(run, { type: "exit", code: 0, signal: null, cancelled: false });
    const html = renderToString(<ReviewRunPanel run={run} />);
    expect(html).toContain('data-run-phase="done"');
    expect(html).toContain("looks fine");
    expect(html).toContain('data-slot="review-run-truncated"');
    expect(html).toContain("Review finished.");
    expect(html).not.toContain("Cancel");
  });

  it("marks a cancelled run as cancelled", () => {
    let run = runStarted("coderabbit", 42, 1);
    run = runEvent(run, { type: "exit", code: null, signal: "SIGTERM", cancelled: true });
    const html = renderToString(<ReviewRunPanel run={run} />);
    expect(html).toContain("cancelled");
    expect(html).toContain("Cancelled.");
  });
});
