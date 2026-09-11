import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ClientTicketCoverage, WorkflowStatePayload, WorkItemRecord } from "../types";
import { ClientTicketsPage } from "./ClientTicketsPage";

const item = (number: number, overrides: Partial<WorkItemRecord> = {}): WorkItemRecord => ({
  id: `GH-${number}`,
  title: `Issue ${number}`,
  url: `https://github.com/example/project/issues/${number}`,
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

const bug = (number: number, overrides: Partial<WorkItemRecord> = {}) =>
  item(number, {
    title: `Client bug ${number}`,
    labels: ["client-bug"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
    ...overrides,
  });

const request = (number: number, overrides: Partial<WorkItemRecord> = {}) =>
  item(number, {
    title: `Client request ${number}`,
    labels: ["client-feedback"],
    createdAt: "2026-09-02T00:00:00Z",
    updatedAt: "2026-09-08T00:00:00Z",
    ...overrides,
  });

const coverage = (overrides: Partial<ClientTicketCoverage> = {}): ClientTicketCoverage => ({
  labels: ["client-bug", "client-feedback"],
  checkedAt: "2026-09-11T08:00:00Z",
  complete: true,
  reasons: [],
  ...overrides,
});

const state = (
  workItems: WorkItemRecord[],
  clientCoverage: ClientTicketCoverage | undefined = coverage(),
): WorkflowStatePayload => ({
  workItems,
  maps: [],
  blockerEdges: [],
  decisions: [],
  artifacts: [],
  meta: { snapshot: "2026-09-11T09:00:00Z", repo: "example/project" },
  ...(clientCoverage ? { clientCoverage } : {}),
});

const renderPage = (overrides: Partial<Parameters<typeof ClientTicketsPage>[0]> = {}) =>
  renderToString(
    <ClientTicketsPage
      state={state([bug(12), request(8)])}
      mode="live"
      lens={undefined}
      ownership="all"
      waiting={false}
      q=""
      onLensChange={() => {}}
      onOwnershipChange={() => {}}
      onWaitingChange={() => {}}
      onQueryChange={() => {}}
      onOpenIssue={() => {}}
      closed={null}
      closedPending={false}
      closedError={null}
      onRefreshClosed={() => {}}
      {...overrides}
    />,
  );

const withoutComments = (html: string) => html.replace(/<!-- -->/g, "");

describe("client tickets page", () => {
  it("renders both tiers with kind badges and the unfiltered open totals", () => {
    const html = withoutComments(renderPage());
    expect(html).toContain("client bug");
    expect(html).toContain("client request");
    expect(html).toContain("1 open bug");
    expect(html).toContain("1 open request");
    expect(html).toContain("totals never hide behind a filter");
  });

  it("shows issue age and last update as plain data, with triage state", () => {
    const html = withoutComments(renderPage());
    expect(html).toContain("opened");
    expect(html).toContain("updated");
    expect(html).toContain("triage unlabeled");
    expect(html).toContain("GitHub ↗");
  });

  it("marks unassigned rows and waiting rows in words, not just color", () => {
    const html = withoutComments(
      renderPage({
        state: state([bug(12, { triageState: "needs-info" }), request(8, { assignees: ["vvaz"] })]),
      }),
    );
    expect(html).toContain('data-unassigned="1"');
    expect(html).toContain("waiting on information");
    expect(html).toContain("unassigned");
  });

  it("narrows rows behind filters while the totals stay visible", () => {
    const html = withoutComments(
      renderPage({ lens: "bugs", q: "Client bug 12", ownership: "unassigned", waiting: true }),
    );
    expect(html).toContain("Client bug 12");
    expect(html).not.toContain("Client request 8");
    expect(html).toContain("1 open bug");
    expect(html).toContain("1 open request");
  });

  it("keeps the zero state calm and distinct when nothing is open", () => {
    const html = withoutComments(renderPage({ state: state([]) }));
    expect(html).toContain("No open client tickets — internal work is not gated.");
    expect(html).not.toContain("coverage");
  });

  it("renders unknown and incomplete coverage as warnings, never as a quiet zero", () => {
    // An older snapshot carries no coverage at all — the key itself absent.
    const unknownState = { ...state([]), clientCoverage: undefined };
    const unknown = withoutComments(renderPage({ state: unknownState }));
    expect(unknown).toContain("Client coverage unknown");

    const partial = withoutComments(
      renderPage({
        state: state([bug(12)], coverage({ complete: false, reasons: ["page-cap:client-bug"] })),
      }),
    );
    expect(partial).toContain("Client coverage incomplete");
    expect(partial).toContain("page-cap:client-bug");
  });

  it("names closure reasons honestly in the closed lens", () => {
    const closed = {
      tickets: [
        bug(12, { state: "closed", stateReason: "completed" }),
        request(8, { state: "closed", stateReason: "not_planned" }),
        item(15, { state: "closed", title: "Client bug 15", labels: ["client-bug"] }),
      ],
      coverage: coverage(),
    };
    const html = withoutComments(
      renderPage({ lens: "closed", closed, closedPending: false, closedError: null }),
    );
    expect(html).toContain("closed — completed");
    expect(html).toContain("closed — not planned");
    expect(html).toContain("closed");
    expect(html).toContain("Bounded history");
    expect(html).not.toContain('data-unassigned="1"');
  });

  it("distinguishes the closed lens loading, error, and static states", () => {
    const loading = withoutComments(
      renderPage({ lens: "closed", closedPending: true, closedError: null }),
    );
    expect(loading).toContain("Loading closed client tickets");

    const failed = withoutComments(
      renderPage({ lens: "closed", closedError: "closed client tickets unavailable: 503" }),
    );
    expect(failed).toContain("closed client tickets unavailable: 503");

    const staticMode = withoutComments(renderPage({ lens: "closed", mode: "static" }));
    expect(staticMode).toContain("needs the dev server");
  });
});
