import { describe, expect, it } from "vite-plus/test";

import type { TrackerMapRecord, WorkItemRecord } from "../types";
import { isMapChild, staticMoveCommand, targetStatesFor, triageLanes } from "./triage";

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

const maps: TrackerMapRecord[] = [
  {
    mapId: "GH-41",
    title: "Skills-ecosystem dashboard",
    url: "https://github.com/Quick-Release/workbench/issues/41",
    ticketIds: ["GH-42", "GH-43"],
  },
];

const ids = (rows: readonly WorkItemRecord[]) => rows.map((row) => row.id);

describe("triage lanes", () => {
  it("holds unlabeled and needs-triage issues in the intake lane, number ascending", () => {
    const lanes = triageLanes(
      [item(61, { triageState: "needs-triage" }), item(8), item(60, { triageState: "unlabeled" })],
      maps,
    );
    expect(ids(lanes.intake)).toEqual(["GH-8", "GH-60", "GH-61"]);
  });

  it("excludes map decision tickets from intake so map work never poses as triage work", () => {
    const lanes = triageLanes([item(42), item(8)], maps);
    expect(ids(lanes.intake)).toEqual(["GH-8"]);
  });

  it("groups the waiting lane by whose move it is", () => {
    const lanes = triageLanes(
      [
        item(37, { triageState: "needs-info" }),
        item(39, { triageState: "ready-for-human" }),
        item(24, { deferred: true, triageState: "needs-triage" }),
      ],
      maps,
    );
    expect(ids(lanes.waiting.reporter)).toEqual(["GH-37"]);
    expect(ids(lanes.waiting.human)).toEqual(["GH-39"]);
    expect(ids(lanes.waiting.parked)).toEqual(["GH-24"]);
    expect(lanes.intake).toEqual([]);
  });

  it("resolves an item claiming two lanes by whose-move order, reporter first", () => {
    const lanes = triageLanes(
      [
        item(37, { triageState: "needs-info", deferred: true }),
        item(39, { triageState: "ready-for-human", deferred: true }),
      ],
      maps,
    );
    expect(ids(lanes.waiting.reporter)).toEqual(["GH-37"]);
    expect(ids(lanes.waiting.human)).toEqual(["GH-39"]);
    expect(lanes.waiting.parked).toEqual([]);
  });

  it("keeps refused items out of every lane but the lens", () => {
    const lanes = triageLanes([item(39, { triageState: "wontfix" }), item(8)], maps);
    expect(ids(lanes.refused)).toEqual(["GH-39"]);
    expect(ids(lanes.intake)).toEqual(["GH-8"]);
  });

  it("renders nothing for closed items and for work already triaged ready", () => {
    const lanes = triageLanes(
      [
        item(12, { state: "closed", triageState: "wontfix" }),
        item(6, { triageState: "ready-for-agent", assignees: ["vvaz"] }),
        item(58, { triageState: "ready-for-agent" }),
      ],
      maps,
    );
    expect(lanes.intake).toEqual([]);
    expect(lanes.refused).toEqual([]);
    expect(lanes.waiting.reporter).toEqual([]);
    expect(lanes.waiting.human).toEqual([]);
    expect(lanes.waiting.parked).toEqual([]);
  });
});

describe("triage move targets", () => {
  it("offers every state but the current one", () => {
    expect(targetStatesFor("needs-triage", false)).toEqual([
      "needs-info",
      "ready-for-agent",
      "ready-for-human",
      "unlabeled",
    ]);
  });

  it("reaches wontfix only behind the deliberate lens", () => {
    expect(targetStatesFor("needs-triage", false)).not.toContain("wontfix");
    expect(targetStatesFor("needs-triage", true)).toEqual([
      "needs-info",
      "ready-for-agent",
      "ready-for-human",
      "unlabeled",
      "wontfix",
    ]);
  });
});

describe("static move command degradation", () => {
  it("copies the settle command for intake work", () => {
    expect(staticMoveCommand(item(61, { triageState: "needs-triage" }))).toBe(
      "gh issue edit 61 --add-label ready-for-agent --remove-label needs-triage",
    );
    expect(staticMoveCommand(item(8))).toBe("gh issue edit 8 --add-label ready-for-agent");
  });

  it("sends parked work back through evaluation, un-parking it", () => {
    expect(staticMoveCommand(item(24, { deferred: true }))).toBe(
      "gh issue edit 24 --add-label needs-triage --remove-label deferred",
    );
    expect(staticMoveCommand(item(24, { deferred: true, triageState: "needs-triage" }))).toBe(
      "gh issue edit 24 --add-label needs-triage --remove-label deferred",
    );
  });

  it("offers no command for a refusal — wontfix is terminal", () => {
    expect(staticMoveCommand(item(39, { triageState: "wontfix" }))).toBe("");
  });
});

describe("map membership", () => {
  it("recognizes a map child by the map's ticket ids", () => {
    expect(isMapChild(item(42), maps)).toBe(true);
    expect(isMapChild(item(8), maps)).toBe(false);
  });
});

describe("client tier ordering (ADR 0012)", () => {
  it("heads every lane with client tickets — bugs, then feedback, then number", () => {
    const lanes = triageLanes(
      [
        item(12, { triageState: "needs-triage" }),
        item(3, { labels: ["client-bug"], triageState: "needs-triage" }),
        item(7, { labels: ["client-feedback"], triageState: "needs-triage" }),
        item(9, { labels: ["client-bug"], triageState: "needs-triage" }),
      ],
      maps,
    );
    expect(lanes.intake.map((row) => row.id)).toEqual(["GH-3", "GH-9", "GH-7", "GH-12"]);
    expect(lanes.intake[3]?.triageState).toBe("needs-triage");
  });
});
