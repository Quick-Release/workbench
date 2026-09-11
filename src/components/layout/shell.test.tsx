import { renderToString } from "react-dom/server";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import type { OverviewData } from "../../types";
import { setWorkflowState } from "../../hooks/use-workflow-state";

import { AppShell } from "./app-shell";

const meta = {
  projectName: "banquinha",
  theme: {} as OverviewData["meta"]["theme"],
  services: [],
  snapshot: "2026-08-29T15:11:41+01:00",
  branch: "main",
  commit: "abc1234def5678",
  repo: "Quick-Release/banquinha",
  repositoryUrl: "https://github.com/Quick-Release/banquinha",
  docsRoot: "docs",
  sources: [],
} satisfies OverviewData["meta"];

const renderShellAt = async (path: string) => {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell meta={meta}>
        <Outlet />
      </AppShell>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>stub:overview</div>,
  });
  const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions",
    component: () => <div>stub:sessions</div>,
  });
  const flowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/flow",
    component: () => <div>stub:flow</div>,
  });
  const triageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/triage",
    component: () => <div>stub:triage</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, sessionsRoute, flowRoute, triageRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToString(<RouterProvider router={router} />);
};

const anchorFor = (html: string, path: string) =>
  (html.match(/<a\b[^>]*>/g) ?? []).find((tag) =>
    new RegExp(`href="${path}(?:\\?[^"]*)?"`).test(tag),
  ) ?? "";

describe("app shell (shadcn dashboard frame)", () => {
  it("renders the sidebar, inset, header, and the routed page inside the frame", async () => {
    const html = await renderShellAt("/");
    expect(html).toContain('data-slot="sidebar-wrapper"');
    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain('data-slot="sidebar-trigger"');
    expect(html).toContain('data-slot="sidebar-inset"');
    expect(html).toContain('data-slot="header"');
    expect(html).toContain("stub:overview");
  });

  it("shows the brand, project name, freshness chip, posture badge, and both header links", async () => {
    // GH-145: the header freshness line reads the shared atom, not the meta
    // prop — seed it so the assertion is hermetic against whatever the
    // generated snapshot carries.
    setWorkflowState({
      workItems: [],
      maps: [],
      blockerEdges: [],
      decisions: [],
      artifacts: [],
      meta: {
        snapshot: meta.snapshot,
        repo: meta.repo,
        syncedAt: "2026-08-29T15:11:41+01:00",
      },
    });
    const html = await renderShellAt("/");
    expect(html).toContain("work");
    expect(html).toContain("bench");
    expect(html).toContain("banquinha");
    expect(html).toContain('data-slot="freshness-chip"');
    expect(html).toContain("synced");
    expect(html).toContain("control surface / localhost");
    expect(html).toContain("agent sessions");
    expect(html).toContain("repository ↗");
  });

  it("marks exactly the active route in the sidebar nav", async () => {
    const home = await renderShellAt("/");
    const sessions = await renderShellAt("/sessions");
    const flow = await renderShellAt("/flow");
    const triage = await renderShellAt("/triage");
    expect(anchorFor(home, "/")).toContain('data-active="true"');
    expect(anchorFor(home, "/")).not.toContain('data-active="false"');
    expect(anchorFor(home, "/sessions")).toContain('data-active="false"');
    expect(anchorFor(home, "/flow")).toContain('data-active="false"');
    expect(anchorFor(sessions, "/sessions")).toContain('data-active="true"');
    expect(anchorFor(sessions, "/")).toContain('data-active="false"');
    expect(anchorFor(flow, "/flow")).toContain('data-active="true"');
    expect(anchorFor(triage, "/triage")).toContain('data-active="true"');
  });

  it("carries the Workflow nav group led by Skill flow, with the Board beside it", async () => {
    const html = await renderShellAt("/");
    const labels = [...html.matchAll(/data-slot="sidebar-group-label"[^>]*>([^<]+)</g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(["Workspace", "Workflow"]);
    const workspace = html.indexOf('data-slot="sidebar-group-label"');
    const workflow = html.indexOf(">Workflow<");
    const flow = html.indexOf('href="/flow');
    const board = html.indexOf('href="/board"');
    const triage = html.indexOf('href="/triage"');
    const sessions = html.indexOf('href="/sessions"');
    expect(workflow).toBeGreaterThan(workspace);
    expect(flow).toBeGreaterThan(workflow);
    expect(board).toBeGreaterThan(flow);
    expect(triage).toBeGreaterThan(board);
    expect(sessions).toBeGreaterThan(triage);
  });

  it("keeps the repository link external", async () => {
    const html = await renderShellAt("/");
    const repo = anchorFor(html, "https://github.com/Quick-Release/banquinha");
    expect(repo).toContain('target="_blank"');
    expect(repo).toContain('rel="noreferrer"');
  });
});
