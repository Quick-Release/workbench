import { renderToString } from "react-dom/server";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { setWorkflowState } from "../hooks/use-workflow-state";
import { routeTree } from "../routeTree.gen";
import type { WorkItemRecord, WorkflowStatePayload } from "../types";

// Route-level smoke tests (spec #144's testing decisions): the board route
// renders the atom's payload, the deferred lens and the panel param ride the
// URL with triage's validation, and junk params degrade to the plain board.

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

const payload = {
  workItems: [
    item(8, { phase: "implementing", title: "Build the board columns" }),
    item(24, { phase: "ticketed", deferred: true, title: "Parked swimlane idea" }),
  ],
  maps: [],
  blockerEdges: [],
  decisions: [],
  artifacts: [],
  meta: { snapshot: "2026-09-12T00:00:00Z", repo: "Quick-Release/workbench" },
} satisfies WorkflowStatePayload;

// One router over the imported route-tree singleton, navigated through the
// router (not raw history pushes, which bypass search serialization).
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/board"] }),
});

// The panel param navigates typed — the way the app's own links write it —
// because TanStack JSON-parses search values: a hand-typed bare `?issue=8`
// arrives as the number 8 and is rejected exactly like on /triage.
const renderBoardAt = async (
  target: { href: string } | { to: "/board"; search: { issue: string } },
) => {
  setWorkflowState(payload);
  // `href` navigates at runtime but the typed overloads only name `to`.
  await router.navigate(target as Parameters<typeof router.navigate>[0]);
  return renderToString(<RouterProvider router={router} />);
};

const withoutComments = (html: string) => html.replace(/<!-- -->/g, "");

describe("the /board route", () => {
  it("renders the phase columns and cards from the workflow atom", async () => {
    const html = withoutComments(await renderBoardAt({ href: "/board" }));
    expect(html.match(/data-slot="board-column"/g)?.length).toBe(8);
    expect(html).toContain("Build the board columns");
    expect(html).not.toContain("issue-detail-panel");
  });

  it("opens the shared issue detail panel from the ?issue param", async () => {
    const html = withoutComments(await renderBoardAt({ to: "/board", search: { issue: "8" } }));
    expect(html).toContain('data-slot="issue-detail-panel"');
    expect(html).toContain("Build the board columns");
  });

  it("drops a junk ?issue param instead of guessing a panel", async () => {
    const html = withoutComments(await renderBoardAt({ href: "/board?issue=banana" }));
    expect(html).not.toContain("issue-detail-panel");
    expect(html).toContain("Build the board columns");
  });

  it("shows parked work through a deep-linked ?lens=deferred", async () => {
    const plain = withoutComments(await renderBoardAt({ href: "/board" }));
    expect(plain).not.toContain("Parked swimlane idea");
    const throughLens = withoutComments(await renderBoardAt({ href: "/board?lens=deferred" }));
    expect(throughLens).toContain("Parked swimlane idea");
  });

  it("ignores an unknown lens value and renders the plain board", async () => {
    const html = withoutComments(await renderBoardAt({ href: "/board?lens=shelved" }));
    expect(html).not.toContain("Parked swimlane idea");
    expect(html).toContain("Build the board columns");
  });
});
