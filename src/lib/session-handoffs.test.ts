import { describe, expect, it } from "vite-plus/test";

import type { SessionUsageRecord } from "../types";
import { sessionHandoffs } from "./session-handoffs";

const session = (id: string, overrides: Partial<SessionUsageRecord> = {}): SessionUsageRecord => ({
  id,
  taskType: "interactive",
  parent: "",
  title: `Session ${id}`,
  directory: "/tmp/checkout",
  started: "2026-09-01T10:00:00.000Z",
  requests: 1,
  inputTokens: 100,
  outputTokens: 100,
  modelMs: 1000,
  model: "GLM-5.3-Flash",
  edits: 0,
  writes: 0,
  skillCalls: 0,
  ...overrides,
});

const ids = (nodes: readonly { session: SessionUsageRecord }[]) =>
  nodes.map((node) => node.session.id);

describe("session handoffs", () => {
  it("joins recorded parent links into parent/child trees, one boundary per link", () => {
    const forest = sessionHandoffs([
      session("root", { started: "2026-09-01T10:00:00.000Z" }),
      session("child-late", {
        parent: "root",
        taskType: "subagent_child",
        started: "2026-09-01T10:30:00.000Z",
      }),
      session("child-early", {
        parent: "root",
        taskType: "subagent_child",
        started: "2026-09-01T10:20:00.000Z",
      }),
    ]);
    expect(forest.boundaries).toBe(2);
    expect(ids(forest.roots)).toEqual(["root"]);
    expect(forest.roots[0].caveats).toEqual([]);
    expect(ids(forest.roots[0].children)).toEqual(["child-early", "child-late"]);
  });

  it("renders a parent outside the view as a root naming the gap", () => {
    const forest = sessionHandoffs([
      session("orphan", { parent: "elsewhere", started: "2026-09-01T09:00:00.000Z" }),
      session("standalone", { started: "2026-09-01T11:00:00.000Z" }),
    ]);
    expect(forest.boundaries).toBe(1);
    expect(ids(forest.roots)).toEqual(["orphan", "standalone"]);
    expect(forest.roots[0].caveats).toHaveLength(1);
    expect(forest.roots[0].caveats[0].kind).toBe("parent-outside-view");
    expect(forest.roots[0].caveats[0].message).toContain("elsewhere");
    expect(forest.roots[1].caveats).toEqual([]);
  });

  it("joins regardless of row order — no false gap when a child arrives first", () => {
    const forest = sessionHandoffs([
      session("child", { parent: "root", taskType: "subagent_child" }),
      session("root", { started: "2026-09-01T09:30:00.000Z" }),
    ]);
    expect(ids(forest.roots)).toEqual(["root"]);
    expect(forest.roots[0].caveats).toEqual([]);
    expect(ids(forest.roots[0].children)).toEqual(["child"]);
    expect(forest.boundaries).toBe(1);
  });

  it("renders a parent-link cycle as a caveat on both ends, every session exactly once", () => {
    const forest = sessionHandoffs([
      session("a", { parent: "b", started: "2026-09-01T10:00:00.000Z" }),
      session("b", { parent: "a", started: "2026-09-01T10:05:00.000Z" }),
    ]);
    // Both links were recorded, so both count — including the one the tree
    // cannot honor.
    expect(forest.boundaries).toBe(2);
    expect(ids(forest.roots)).toEqual(["a"]);
    expect(forest.roots[0].caveats.map((caveat) => caveat.kind)).toEqual(["parent-link-cycle"]);
    expect(ids(forest.roots[0].children)).toEqual(["b"]);
    expect(forest.roots[0].children[0].caveats.map((caveat) => caveat.kind)).toEqual([
      "parent-link-cycle",
    ]);

    const seen: string[] = [];
    const walk = (nodes: readonly { session: SessionUsageRecord; children: unknown }[]) => {
      for (const node of nodes) {
        seen.push(node.session.id);
        walk(node.children as never);
      }
    };
    walk(forest.roots);
    expect([...seen].sort()).toEqual(["a", "b"]);
  });

  it("keeps a chain into a cycle attached without spreading the caveat", () => {
    const forest = sessionHandoffs([
      session("a", { parent: "b", started: "2026-09-01T10:00:00.000Z" }),
      session("b", { parent: "a", started: "2026-09-01T10:05:00.000Z" }),
      session("above", { parent: "a", started: "2026-09-01T09:55:00.000Z" }),
      session("below", {
        parent: "above",
        taskType: "subagent_child",
        started: "2026-09-01T09:58:00.000Z",
      }),
    ]);
    expect(ids(forest.roots)).toEqual(["a"]);
    expect(forest.roots[0].caveats.map((caveat) => caveat.kind)).toEqual(["parent-link-cycle"]);
    expect(ids(forest.roots[0].children)).toEqual(["above", "b"]);
    const above = forest.roots[0].children[0];
    expect(above.caveats).toEqual([]);
    expect(ids(above.children)).toEqual(["below"]);
  });
});
