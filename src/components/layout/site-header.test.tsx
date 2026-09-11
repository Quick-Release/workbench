import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { OverviewData, WorkflowStatePayload } from "../../types";
import { setWorkflowState } from "../../hooks/use-workflow-state";
import { SidebarProvider } from "../ui/sidebar";
import { FreshnessChip, SiteHeader, SyncTriggerButton } from "./site-header";

// The header renders inside the app's sidebar context; renderToString knows
// nothing of it, so the integration tests provide the shell directly.
const renderHeader = (meta: React.ComponentProps<typeof SiteHeader>["meta"]) =>
  renderToString(
    <SidebarProvider>
      <SiteHeader meta={meta} />
    </SidebarProvider>,
  );

// GH-145: the header's freshness chip and its fallbacks. The chip is
// prop-driven; the integration tests drive the shared workflow atom the way
// a seam answer would.
describe("FreshnessChip", () => {
  it("renders live freshness as synced-ago", () => {
    const syncedAt = new Date(Date.now() - 30_000).toISOString();
    const html = renderToString(<FreshnessChip syncedAt={syncedAt} mode="live" />);
    expect(html).toContain('data-slot="freshness-chip"');
    expect(html).toContain("synced");
    expect(html).toMatch(/s ago/);
    expect(html).not.toContain("data-stale");
  });

  it("marks a stale stamp", () => {
    const syncedAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const html = renderToString(<FreshnessChip syncedAt={syncedAt} mode="live" />);
    expect(html).toContain("data-stale");
    expect(html).toMatch(/m ago/);
  });

  it("reads static without a seam", () => {
    const html = renderToString(<FreshnessChip syncedAt={null} mode="static" />);
    expect(html).toContain('data-slot="freshness-chip"');
    expect(html).toContain("data-static");
    expect(html).toContain("static snapshot");
  });

  it("renders nothing live without a stamp — the snapshot stamp falls back", () => {
    const html = renderToString(<FreshnessChip syncedAt={null} mode="live" />);
    expect(html).not.toContain("freshness-chip");
  });
});

describe("SyncTriggerButton", () => {
  it("offers the sync beside the freshness chip", () => {
    const html = renderToString(<SyncTriggerButton pending={false} onSync={() => {}} />);
    expect(html).toContain('data-slot="header-sync-trigger"');
    expect(html).toContain("Sync");
    expect(html).not.toContain('disabled=""');
  });

  it("reads pending while a sync runs", () => {
    const html = renderToString(<SyncTriggerButton pending={true} onSync={() => {}} />);
    expect(html).toContain("Syncing…");
    expect(html).toContain('disabled=""');
  });
});

describe("SiteHeader", () => {
  // The theme is the app's concern; the header only reads the name and repo.
  const meta = {
    projectName: "workbench",
    theme: {},
    services: [],
    snapshot: "2026-09-05T12:00:00+01:00",
    branch: "main",
    commit: "abc1234",
    repo: "Quick-Release/workbench",
    repositoryUrl: "https://github.com/Quick-Release/workbench",
    docsRoot: "docs",
    sources: [],
  } as unknown as OverviewData["meta"];
  const payloadWith = (syncedAt?: string): WorkflowStatePayload => ({
    workItems: [],
    maps: [],
    blockerEdges: [],
    decisions: [],
    artifacts: [],
    meta: { snapshot: meta.snapshot, repo: meta.repo, ...(syncedAt ? { syncedAt } : {}) },
  });

  it("shows the synced-ago chip and hides the snapshot stamp when a stamp exists", () => {
    setWorkflowState(payloadWith(new Date(Date.now() - 30_000).toISOString()));
    const html = renderHeader(meta);
    expect(html).toContain('data-slot="freshness-chip"');
    expect(html).not.toContain("LOCAL SNAPSHOT");
  });

  it("falls back to the snapshot stamp for a snapshot without syncedAt", () => {
    setWorkflowState(payloadWith());
    const html = renderHeader(meta);
    expect(html).toContain("LOCAL SNAPSHOT");
    expect(html).not.toContain('data-slot="freshness-chip"');
  });
});
