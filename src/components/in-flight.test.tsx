import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { WorkItemRecord } from "../types";
import { InFlightPage } from "./InFlightPage";

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

const renderPage = (workItems: readonly WorkItemRecord[]) =>
  renderToString(<InFlightPage workItems={workItems} />);

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
});
