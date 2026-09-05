import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { BlockerEdgeRecord, TrackerMapRecord, WorkItemRecord } from "../types";
import { TriagePage, TriageRow } from "./TriagePage";

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

const edges: BlockerEdgeRecord[] = [];

const fixtureItems: WorkItemRecord[] = [
  item(8, { title: "Fresh unlabeled bug", summary: "It crashes on load." }),
  item(11, { title: "Needs-triage feature", triageState: "needs-triage" }),
  item(42, { title: "Map decision ticket" }),
  item(37, { title: "Reporter stalled", triageState: "needs-info" }),
  item(38, { title: "Needs a human", triageState: "ready-for-human" }),
  item(24, { title: "Parked work", deferred: true }),
];

const renderPage = (overrides: Partial<Parameters<typeof TriagePage>[0]> = {}) =>
  renderToString(
    <TriagePage
      workItems={fixtureItems}
      maps={maps}
      blockerEdges={edges}
      mode="live"
      lens="none"
      onLensChange={() => {}}
      onMove={() => {}}
      pendingId={null}
      message={null}
      {...overrides}
    />,
  );

const withoutComments = (html: string) => html.replace(/<!-- -->/g, "");

describe("triage view lanes", () => {
  it("renders the intake lane with fresh work and no map children", () => {
    const html = renderPage();
    expect(html).toContain("Fresh unlabeled bug");
    expect(html).toContain("Needs-triage feature");
    expect(html).not.toContain("Map decision ticket");
  });

  it("groups the waiting lane by whose move it is", () => {
    const html = renderPage();
    expect(html).toContain("Reporter&#x27;s move");
    expect(html).toContain("Reporter stalled");
    expect(html).toContain("Human&#x27;s move");
    expect(html).toContain("Needs a human");
    expect(html).toContain("Parked");
    expect(html).toContain("Parked work");
  });

  it("keeps the intake count honest", () => {
    const html = withoutComments(renderPage());
    expect(html).toContain("<strong>2</strong>");
  });

  it("renders row caveats show-with-caveat instead of hiding them", () => {
    const html = renderToString(
      <TriagePage
        workItems={[
          item(13, {
            title: "Confused item",
            triageState: "needs-info",
            phase: "implementing",
          }),
        ]}
        maps={[]}
        blockerEdges={edges}
        mode="live"
        lens="none"
        onLensChange={() => {}}
        onMove={() => {}}
        pendingId={null}
        message={null}
      />,
    );
    expect(html).toContain("both facts shown");
  });

  it("shows the empty state when nothing waits on triage", () => {
    const html = renderToString(
      <TriagePage
        workItems={[]}
        maps={[]}
        blockerEdges={edges}
        mode="live"
        lens="none"
        onLensChange={() => {}}
        onMove={() => {}}
        pendingId={null}
        message={null}
      />,
    );
    expect(html).toContain("No work waiting for evaluation.");
  });
});

describe("the wontfix lens", () => {
  const refused = item(39, { title: "Refused work", triageState: "wontfix" });

  it("renders no wontfix affordance or lane without the lens", () => {
    const html = renderToString(
      <TriagePage
        workItems={[refused, item(8, { title: "Fresh work" })]}
        maps={[]}
        blockerEdges={edges}
        mode="live"
        lens="none"
        onLensChange={() => {}}
        onMove={() => {}}
        pendingId={null}
        message={null}
      />,
    );
    expect(html).not.toContain("wontfix");
    expect(html).not.toContain("Refused work");
  });

  it("renders the refused lane and move target only behind the lens", () => {
    const html = renderToString(
      <TriagePage
        workItems={[refused]}
        maps={[]}
        blockerEdges={edges}
        mode="live"
        lens="wontfix"
        onLensChange={() => {}}
        onMove={() => {}}
        pendingId={null}
        message={null}
      />,
    );
    expect(html).toContain("Refused work");
    expect(html).toContain("Refused");
    expect(html).toContain("wontfix");
  });
});

describe("triage move affordances", () => {
  it("offers inline moves in live mode, wontfix excluded from the menu", () => {
    const html = renderToString(
      <TriageRow
        record={item(11, { triageState: "needs-triage" })}
        mode="live"
        lens={false}
        confirming={false}
        pending={false}
        onMove={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('data-slot="native-select"');
    expect(html).toContain("ready-for-agent");
    expect(html).not.toContain("wontfix");
  });

  it("demands confirmation before a refusal, behind the lens", () => {
    const confirming = renderToString(
      <TriageRow
        record={item(11)}
        mode="live"
        lens={true}
        confirming={true}
        pending={false}
        onMove={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(withoutComments(confirming)).toContain("Refuse GH-11?");
    expect(confirming).toContain("Confirm refuse");
    expect(confirming).toContain("Keep evaluating");
    const idle = renderToString(
      <TriageRow
        record={item(11)}
        mode="live"
        lens={true}
        confirming={false}
        pending={false}
        onMove={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(withoutComments(idle)).not.toContain("Refuse GH-11?");
  });

  it("degrades moves to copy-the-command when the seam is unreachable", () => {
    const html = renderToString(
      <TriageRow
        record={item(61, { triageState: "needs-triage" })}
        mode="static"
        lens={false}
        confirming={false}
        pending={false}
        onMove={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("<code");
    expect(html).toContain("gh issue edit 61 --add-label ready-for-agent");
    expect(html).not.toContain("native-select");
  });

  it("offers no command for a refusal in static mode", () => {
    const html = renderToString(
      <TriageRow
        record={item(39, { triageState: "wontfix" })}
        mode="static"
        lens={true}
        confirming={false}
        pending={false}
        onMove={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Refusal is terminal");
    expect(html).not.toContain("gh issue edit");
  });

  it("marks a row pending while its move runs", () => {
    const html = renderToString(
      <TriageRow
        record={item(8)}
        mode="live"
        lens={false}
        confirming={false}
        pending={true}
        onMove={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Moving");
  });
});

describe("triage page feedback", () => {
  it("renders the last move message", () => {
    const html = renderPage({ message: "GH-8 moved to ready-for-agent." });
    expect(html).toContain("GH-8 moved to ready-for-agent.");
  });
});
