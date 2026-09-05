import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  BlockerEdgeRecord,
  TrackerMapRecord,
  WorkItemRecord,
  WorkflowStatePayload,
} from "../types";
import { IssueDetailPanel } from "./IssueDetailPanel";

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
    ticketIds: ["GH-42"],
  },
];

const edges: BlockerEdgeRecord[] = [
  {
    blockedId: "GH-42",
    blockerId: "GH-7",
    source: "github-native",
    sourceRef: "https://github.com/Quick-Release/workbench/issues/42",
  },
];

const baseState: WorkflowStatePayload = {
  workItems: [
    item(7, { title: "Confused item", triageState: "needs-info", phase: "implementing" }),
    item(8, { title: "Loner issue" }),
    item(42, { title: "Map ticket", kind: "task", phase: "implementing" }),
  ],
  maps,
  blockerEdges: edges,
  decisions: [],
  artifacts: [],
  meta: { snapshot: "2026-09-05T12:00:00+01:00", repo: "Quick-Release/workbench" },
};

const renderPanel = (
  overrides: Partial<Parameters<typeof IssueDetailPanel>[0]> = {},
  state: WorkflowStatePayload = baseState,
) =>
  renderToString(
    <IssueDetailPanel
      issueId={null}
      state={state}
      mode="live"
      pending={null}
      message={null}
      onOpenChange={() => {}}
      onAction={() => {}}
      {...overrides}
    />,
  );

describe("the panel opens and closes with the search param", () => {
  it("opens on a cold load of a deep link carrying ?issue=7", () => {
    const html = renderPanel({ issueId: "GH-7" });
    expect(html).toContain('data-slot="issue-detail-panel"');
    expect(html).toContain("Confused item");
  });

  it("is absent while the param is unset — browser-back closes it", () => {
    const html = renderPanel({ issueId: null });
    expect(html).not.toContain('data-slot="issue-detail-panel"');
    expect(html).not.toContain("Confused item");
  });
});

describe("the panel renders the work item's state", () => {
  it("renders both facts for a wrong-attribution case", () => {
    const html = renderPanel({ issueId: "GH-7" });
    expect(html).toContain("both facts shown");
    expect(html).toContain("implementing");
    expect(html).toContain("needs-info");
  });

  it("renders a decision ticket's derived phase with its caveat, not its worn label", () => {
    const html = renderPanel({ issueId: "GH-42" });
    expect(html).toContain("ignored for flow math");
  });

  it("names the open blockers fail-closed", () => {
    const html = renderPanel({ issueId: "GH-42" });
    expect(html).toContain("Blocked by");
    expect(html).toContain("GH-7");
  });

  it("renders claim, deferral, and the closed fact", () => {
    const html = renderPanel(
      { issueId: "GH-8" },
      {
        ...baseState,
        workItems: [item(8, { assignees: ["vvaz"], deferred: true, state: "closed" })],
      },
    );
    expect(html).toContain("Claimed by vvaz");
    expect(html).toContain("deferred");
    expect(html).toContain("closed");
  });
});

describe("the panel's actions in live mode", () => {
  it("renders the comment, edit, and GitHub affordances", () => {
    const html = renderPanel({ issueId: "GH-7" });
    expect(html).toContain('aria-label="Comment on GH-7"');
    expect(html).toContain("Comment");
    expect(html).toContain('aria-label="Edit GH-7 title"');
    expect(html).toContain('aria-label="Edit GH-7 body"');
    expect(html).toContain("Save changes");
    expect(html).toContain('href="https://github.com/Quick-Release/workbench/issues/7"');
    expect(html).toContain("open on GitHub");
  });

  it("jumps show-in-graph for items in an effort — map children to their map", () => {
    const html = renderPanel({ issueId: "GH-42" });
    expect(html).toContain('href="/blockers?effort=GH-41&amp;focus=42"');
  });

  it("offers no graph jump for an item no snapshot record places in an effort", () => {
    // GH-7 sits on blocker edges but outside every map — the graph's ticket
    // owns the wider effort semantics, so no link until it lands.
    const html = renderPanel({ issueId: "GH-7" });
    expect(html).not.toContain("/blockers?");
    const loner = renderPanel({ issueId: "GH-8" });
    expect(loner).not.toContain("/blockers?");
  });

  it("marks the running action pending", () => {
    const html = renderPanel({ issueId: "GH-7", pending: "comment" });
    expect(html).toContain("Commenting");
  });
});

describe("static builds degrade the actions to copy-the-command", () => {
  it("renders the gh commands instead of forms", () => {
    const html = renderPanel({ issueId: "GH-7", mode: "static" });
    expect(html).toContain("<code");
    expect(html).toContain("gh issue comment 7 --repo Quick-Release/workbench");
    expect(html).toContain("gh issue edit 7 --repo Quick-Release/workbench");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<input");
  });

  it("keeps state, caveats, and links readable", () => {
    const html = renderPanel({ issueId: "GH-7", mode: "static" });
    expect(html).toContain("both facts shown");
    expect(html).toContain("open on GitHub");
  });
});

describe("create mode and unknown references", () => {
  it("renders the create form for ?issue=new", () => {
    const html = renderPanel({ issueId: "new" });
    expect(html).toContain('aria-label="New issue title"');
    expect(html).toContain('aria-label="New issue body"');
    expect(html).toContain("File issue");
  });

  it("degrades create to the gh command in static mode", () => {
    const html = renderPanel({ issueId: "new", mode: "static" });
    expect(html).toContain("gh issue create --repo Quick-Release/workbench");
    expect(html).not.toContain("<textarea");
  });

  it("fails soft on an issue the snapshot does not carry", () => {
    const html = renderPanel({ issueId: "GH-404" });
    expect(html).toContain("GH-404");
    expect(html).toContain("not in the snapshot");
    expect(html).toContain('href="https://github.com/Quick-Release/workbench/issues/404"');
  });
});
