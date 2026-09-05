import { describe, expect, it } from "vite-plus/test";

import type { ArtifactRecord, DecisionRecord } from "../types";
import { decisionGroups, unlinkedWarning } from "./decisions";

const adr = (id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  source: "adr",
  workItemId: null,
  title: `ADR ${id}`,
  statement: null,
  status: "accepted",
  supersedes: null,
  decidedAt: null,
  sourceRef: `docs/adr/${id.toLowerCase()}.md`,
  ...overrides,
});

const resolution = (id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  source: "resolution",
  workItemId: id,
  title: `Resolve ${id}`,
  statement: "Resolved by the ADR.",
  status: null,
  supersedes: null,
  decidedAt: "2026-09-01T12:00:00Z",
  sourceRef: `https://github.com/Quick-Release/workbench/issues/${id.slice(3)}#issuecomment-1`,
  ...overrides,
});

const artifact = (id: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  id,
  kind: "research-note",
  path: `docs/research/${id.toLowerCase()}.md`,
  title: `Note ${id}`,
  workItemId: null,
  ...overrides,
});

describe("decision grouping", () => {
  it("groups the records of one work item together without merging their forms", () => {
    const groups = decisionGroups(
      [adr("ADR-0005", { workItemId: "GH-44" }), resolution("GH-44")],
      [artifact("RN-graph-rendering", { workItemId: "GH-43" })],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].workItemId).toBe("GH-43");
    expect(groups[0].artifacts.map((record) => record.id)).toEqual(["RN-graph-rendering"]);
    expect(groups[1].workItemId).toBe("GH-44");
    expect(groups[1].decisions.map((record) => record.id)).toEqual(["ADR-0005", "GH-44"]);
    expect(groups[1].artifacts).toEqual([]);
  });

  it("orders linked groups by work item id, numerically within a namespace", () => {
    const groups = decisionGroups(
      [
        resolution("GH-44"),
        resolution("GH-9"),
        adr("ADR-0005", { workItemId: "GH-44" }),
        resolution("GH-42"),
      ],
      [],
    );
    expect(groups.map((group) => group.workItemId)).toEqual(["GH-9", "GH-42", "GH-44"]);
  });

  it("keeps unlinked decisions and artifacts in one explicit group placed last", () => {
    const groups = decisionGroups(
      [adr("ADR-0001"), resolution("GH-42"), adr("ADR-0003")],
      [
        artifact("RN-effect-adoption"),
        artifact("RN-session-db-attribution", { workItemId: "GH-42" }),
      ],
    );
    const linked = groups.filter((group) => group.workItemId !== null);
    expect(linked.map((group) => group.workItemId)).toEqual(["GH-42"]);
    const unlinked = groups[groups.length - 1];
    expect(unlinked.workItemId).toBeNull();
    expect(unlinked.decisions.map((record) => record.id)).toEqual(["ADR-0001", "ADR-0003"]);
    expect(unlinked.artifacts.map((record) => record.id)).toEqual(["RN-effect-adoption"]);
  });

  it("emits no unlinked group when every record carries its work item", () => {
    const groups = decisionGroups(
      [resolution("GH-42")],
      [artifact("RN-session-db-attribution", { workItemId: "GH-42" })],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].workItemId).toBe("GH-42");
  });

  it("surfaces the unlinked group's warning naming its size", () => {
    expect(unlinkedWarning(1)).toBe(
      "1 record carries no Work item linkage; grouped here so the gap stays visible",
    );
    expect(unlinkedWarning(2)).toBe(
      "2 records carry no Work item linkage; grouped here so the gap stays visible",
    );
  });

  it("groups deterministically for identical input in any order", () => {
    const shapes = [
      decisionGroups([resolution("GH-44"), adr("ADR-0005", { workItemId: "GH-44" })], []),
      decisionGroups([adr("ADR-0005", { workItemId: "GH-44" }), resolution("GH-44")], []),
    ];
    const ids = shapes.map((groups) => groups.map((g) => g.decisions.map((r) => r.id)));
    expect(ids[0]).toEqual(ids[1]);
  });
});
