import { describe, expect, it } from "vite-plus/test";

import type { IssuePanelAction } from "../components/IssueDetailPanel";
import { issueActionBody, issueActionRoute, parseIssueActionResult } from "./issue-actions";

describe("the panel action wire grammar", () => {
  it("routes each action under /api/workflow with exactly its schema's fields", () => {
    const cases: [IssuePanelAction, string, Record<string, unknown>][] = [
      [
        { kind: "comment", issueId: "GH-7", body: "Settled." },
        "issue/comment",
        { issueId: "GH-7", body: "Settled." },
      ],
      [
        { kind: "edit", issueId: "GH-7", title: "T", body: "B", confirm: true },
        "issue/edit",
        { issueId: "GH-7", title: "T", body: "B", confirm: true },
      ],
      [{ kind: "create", title: "T", body: "B" }, "issue/create", { title: "T", body: "B" }],
      [
        { kind: "edge-add", blockedId: "GH-66", blockerId: "GH-64" },
        "edge/add",
        { blockedId: "GH-66", blockerId: "GH-64" },
      ],
      [
        { kind: "edge-remove", blockedId: "GH-66", blockerId: "GH-64", confirm: true },
        "edge/remove",
        { blockedId: "GH-66", blockerId: "GH-64", confirm: true },
      ],
      [
        { kind: "phase-move", issueId: "GH-8", phase: "reviewing" },
        "phase",
        { issueId: "GH-8", phase: "reviewing" },
      ],
      [
        { kind: "phase-move", issueId: "GH-8", phase: "pre-flow" },
        "phase",
        { issueId: "GH-8", phase: "pre-flow" },
      ],
    ];
    for (const [action, route, body] of cases) {
      expect(issueActionRoute(action)).toBe(route);
      expect(issueActionBody(action)).toEqual(body);
    }
  });

  it("parses each action's result through its own schema", () => {
    const state = {
      workItems: [],
      maps: [],
      blockerEdges: [],
      decisions: [],
      artifacts: [],
      meta: { snapshot: "2026-09-05T12:00:00+01:00", repo: "Quick-Release/workbench" },
    };
    expect(
      parseIssueActionResult("edge-add", {
        message: "GH-66 is now blocked by GH-64.",
        blockedId: "GH-66",
        blockerId: "GH-64",
        state,
      }),
    ).toEqual({
      message: "GH-66 is now blocked by GH-64.",
      blockedId: "GH-66",
      blockerId: "GH-64",
      state,
    });
    expect(() => parseIssueActionResult("edge-remove", { message: "nope", undo: true })).toThrow(
      /undo|blockerId|blockedId|state|message/,
    );
    expect(
      parseIssueActionResult("phase-move", {
        message: "GH-8 moved to reviewing.",
        issueId: "GH-8",
        phase: "reviewing",
        state,
      }),
    ).toEqual({
      message: "GH-8 moved to reviewing.",
      issueId: "GH-8",
      phase: "reviewing",
      state,
    });
    expect(() =>
      parseIssueActionResult("phase-move", {
        message: "nope",
        issueId: "GH-8",
        phase: "archived",
        state,
      }),
    ).toThrow(/phase/);
  });
});
