import { describe, expect, it } from "vite-plus/test";

import {
  byIssueNumber,
  compareWorkItemIds,
  workItemIdLabel,
  workItemIdNamespace,
  workItemIdNumber,
  workItemIdNumberText,
} from "./work-item-id";

describe("work-item id grammar", () => {
  it("parses the tracker namespace and number", () => {
    expect(workItemIdNamespace("GH-41")).toBe("GH");
    expect(workItemIdNumber("GH-41")).toBe(41);
    expect(workItemIdNumberText("GH-41")).toBe("41");
    expect(workItemIdLabel("GH-41")).toBe("#41");
  });

  it("parses the other namespaces the snapshot carries", () => {
    expect(workItemIdNamespace("ADR-0007")).toBe("ADR");
    expect(workItemIdNumber("ADR-0007")).toBe(7);
    expect(workItemIdNumber("RN-graph-rendering")).toBe(0);
  });

  it("orders ids by namespace first, then number", () => {
    expect(compareWorkItemIds("GH-9", "GH-10")).toBeLessThan(0);
    expect(compareWorkItemIds("GH-10", "GH-9")).toBeGreaterThan(0);
    expect(compareWorkItemIds("ADR-0009", "GH-1")).toBeLessThan(0);
    expect(compareWorkItemIds("GH-41", "GH-41")).toBe(0);
  });

  it("sorts records by issue number ascending", () => {
    const records = [{ id: "GH-10" }, { id: "GH-9" }, { id: "GH-2" }];
    expect([...records].sort(byIssueNumber).map((record) => record.id)).toEqual([
      "GH-2",
      "GH-9",
      "GH-10",
    ]);
  });
});
