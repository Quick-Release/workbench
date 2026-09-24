import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ClarificationRunSummary, WorkItemRecord } from "../types";
import { InFlightPage } from "./InFlightPage";

const run = (overrides: Partial<ClarificationRunSummary> = {}): ClarificationRunSummary => ({
  runId: "run_1",
  issueId: "64",
  state: "active",
  createdAt: "2026-09-18T10:00:01.000Z",
  updatedAt: "2026-09-18T10:00:01.000Z",
  ...overrides,
});

const item = (number: number, overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id: `GH-${number}`,
  title: `Issue ${number}`,
  url: `https://github.com/Quick-Release/workbench/issues/${number}`,
  state: "open",
  assignees: [],
  phase: null,
  triageState: "unlabeled",
  deferred: false,
  category: null,
  kind: null,
  summary: "",
  ...overrides,
});

const renderPage = (
  workItems: readonly WorkItemRecord[],
  runs?: readonly ClarificationRunSummary[],
) => renderToString(<InFlightPage workItems={workItems} runs={runs} />);

describe("the in-flight view", () => {
  it("renders the buckets in priority order with their membership", () => {
    const html = renderPage([
      item(64, { title: "Claimed work", assignees: ["vvaz"] }),
      item(58, { title: "Implementing work", assignees: ["vvaz"], phase: "implementing" }),
      item(71, { title: "Later review", assignees: ["matt"], phase: "reviewing" }),
      item(9, { title: "First review", assignees: ["matt"], phase: "reviewing" }),
    ]);
    const reviewing = html.indexOf(">Reviewing<");
    const implementing = html.indexOf(">Implementing<");
    const claimed = html.indexOf(">Claimed — not started<");
    expect(reviewing).toBeGreaterThan(-1);
    expect(implementing).toBeGreaterThan(reviewing);
    expect(claimed).toBeGreaterThan(implementing);
    expect(html).toContain("First review");
    expect(html).toContain("Later review");
    expect(html).toContain("Implementing work");
    expect(html).toContain("Claimed work");
    expect(html.indexOf("First review")).toBeLessThan(html.indexOf("Later review"));
  });

  it("keeps excluded states off the view", () => {
    const html = renderPage([
      item(13, {
        title: "Waiting on reporter",
        assignees: ["vvaz"],
        phase: "implementing",
        triageState: "needs-info",
      }),
      item(24, { title: "Parked", assignees: ["vvaz"], phase: "implementing", deferred: true }),
      item(9, { title: "Live review", assignees: ["vvaz"], phase: "reviewing" }),
    ]);
    expect(html).toContain("Live review");
    expect(html).not.toContain("Waiting on reporter");
    expect(html).not.toContain("Parked");
  });

  it("marks claimed-but-not-started rows informational and renders no action affordances", () => {
    const html = renderPage([
      item(65, { title: "In review", assignees: ["vvaz"], phase: "reviewing" }),
      item(64, { title: "Just claimed", assignees: ["vvaz"] }),
    ]);
    expect(html.match(/data-informational/g)?.length).toBe(1);
    expect(html).toContain("session spawning");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("native-select");
  });

  it("renders wrong attribution show-with-caveat instead of hiding it", () => {
    const html = renderPage([
      item(42, {
        title: "Decision ticket",
        assignees: ["vvaz"],
        phase: "implementing",
        kind: "task",
      }),
    ]);
    expect(html).toContain("ignored for flow math");
  });

  it("renders the empty state when nothing is in flight", () => {
    const html = renderPage([]);
    expect(html).toContain("Nothing is in flight");
  });

  it("chips the run lifecycle word onto rows with a live clarification run", () => {
    const html = renderPage(
      [item(64, { title: "Clarifying", assignees: ["vvaz"], phase: "implementing" })],
      [run({ issueId: "64", state: "awaiting-human" })],
    );
    expect(html).toContain('data-slot="in-flight-run-state"');
    expect(html).toContain('data-run-state="awaiting-human"');
    expect(html).toContain("awaiting-human");
  });

  it("renders an unknown run state as the word, amber, never a spinner", () => {
    const html = renderPage(
      [item(64, { title: "Clarifying", assignees: ["vvaz"], phase: "implementing" })],
      [run({ issueId: "64", state: "unknown" })],
    );
    const chip = html.match(/<span[^>]*data-run-state="unknown"[^>]*>/);
    expect(chip).toBeTruthy();
    expect(chip?.[0]).toContain("amber");
  });

  it("chips nothing for a finished run and never renders actions for the chip", () => {
    const html = renderPage(
      [item(64, { title: "Done clarifying", assignees: ["vvaz"], phase: "implementing" })],
      [run({ issueId: "64", state: "terminal" })],
    );
    expect(html).not.toContain("in-flight-run-state");

    const withRuns = renderPage(
      [item(64, { title: "Clarifying", assignees: ["vvaz"], phase: "implementing" })],
      [run({ issueId: "64", state: "active" })],
    );
    expect(withRuns).toContain("in-flight-run-state");
    expect(withRuns).not.toContain("<button");
    // Workflow phases stay GitHub's: the run chip rides next to the phase
    // badge, it never replaces or moves it.
    expect(withRuns).toContain("implementing");
  });
});
