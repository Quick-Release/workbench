import { describe, expect, it } from "vite-plus/test";

import type { WorkItemRecord } from "../types";
import { inFlightBuckets } from "./in-flight";

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

const ids = (rows: readonly WorkItemRecord[]) => rows.map((row) => row.id);

describe("in-flight buckets", () => {
  it("sorts claimed work into reviewing, implementing, then claimed-not-started", () => {
    const buckets = inFlightBuckets([
      item(58, { assignees: ["vvaz"], phase: "implementing" }),
      item(65, { assignees: ["vvaz"], phase: "reviewing" }),
      item(64, { assignees: ["vvaz"], triageState: "ready-for-agent" }),
    ]);
    expect(ids(buckets.reviewing)).toEqual(["GH-65"]);
    expect(ids(buckets.implementing)).toEqual(["GH-58"]);
    expect(ids(buckets.notStarted)).toEqual(["GH-64"]);
  });

  it("breaks ties inside a bucket by issue number ascending", () => {
    const buckets = inFlightBuckets([
      item(71, { assignees: ["vvaz"], phase: "reviewing" }),
      item(9, { assignees: ["matt"], phase: "reviewing" }),
      item(24, { assignees: ["vvaz"], phase: "implementing" }),
    ]);
    expect(ids(buckets.reviewing)).toEqual(["GH-9", "GH-71"]);
    expect(ids(buckets.implementing)).toEqual(["GH-24"]);
  });

  it("keeps excluded states off the view — they wait elsewhere", () => {
    const buckets = inFlightBuckets([
      item(13, { assignees: ["vvaz"], phase: "implementing", triageState: "needs-info" }),
      item(14, { assignees: ["vvaz"], phase: "reviewing", triageState: "ready-for-human" }),
      item(24, { assignees: ["vvaz"], phase: "implementing", deferred: true }),
      item(39, { assignees: ["vvaz"], phase: "grilling", triageState: "wontfix" }),
      item(12, { assignees: ["vvaz"], phase: "shipped", triageState: "ready-for-agent" }),
    ]);
    expect(buckets.reviewing).toEqual([]);
    expect(buckets.implementing).toEqual([]);
    expect(buckets.notStarted).toEqual([]);
  });

  it("renders only assigned work — history and unclaimed phases stay off", () => {
    const buckets = inFlightBuckets([
      item(55, { state: "closed", assignees: ["vvaz"], phase: "reviewing" }),
      item(70, { phase: "reviewing" }),
      item(28, { phase: "implementing" }),
    ]);
    expect(buckets.reviewing).toEqual([]);
    expect(buckets.implementing).toEqual([]);
    expect(buckets.notStarted).toEqual([]);
  });

  it("reads claimed decision tickets as not started, their phase deriving from state", () => {
    const buckets = inFlightBuckets([
      item(42, { assignees: ["vvaz"], phase: "implementing", kind: "task" }),
      item(44, { assignees: ["vvaz"], phase: "implementing", kind: "research" }),
    ]);
    expect(ids(buckets.notStarted)).toEqual(["GH-42", "GH-44"]);
    expect(buckets.implementing).toEqual([]);
  });
});

describe("client tier ordering (ADR 0012)", () => {
  it("heads in-flight buckets with client tickets, then issue number", () => {
    const buckets = inFlightBuckets([
      item(71, { assignees: ["vvaz"], phase: "reviewing" }),
      item(9, { labels: ["client-bug"], assignees: ["vvaz"], phase: "reviewing" }),
      item(24, { labels: ["client-feedback"], assignees: ["vvaz"], phase: "implementing" }),
      item(30, { assignees: ["vvaz"], phase: "implementing" }),
    ]);
    expect(ids(buckets.reviewing)).toEqual(["GH-9", "GH-71"]);
    expect(ids(buckets.implementing)).toEqual(["GH-24", "GH-30"]);
  });
});
