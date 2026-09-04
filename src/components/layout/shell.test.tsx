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
  sources: [{ label: "Ledger", path: "docs/dashboard-plan/status.md" }],
  ticketCount: 2,
  planCount: 1,
  changeCount: 1,
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
  const skillsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills",
    component: () => <div>stub:skills</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, sessionsRoute, skillsRoute]),
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

  it("shows the brand, project name, snapshot line, read-only badge, and both header links", async () => {
    const html = await renderShellAt("/");
    expect(html).toContain("work");
    expect(html).toContain("bench");
    expect(html).toContain("banquinha");
    expect(html).toContain("LOCAL SNAPSHOT");
    expect(html).toContain("29 Aug 2026");
    expect(html).toContain("read-only / local");
    expect(html).toContain("agent sessions");
    expect(html).toContain("repository ↗");
  });

  it("marks exactly the active route in the sidebar nav", async () => {
    const home = await renderShellAt("/");
    const sessions = await renderShellAt("/sessions");
    const skills = await renderShellAt("/skills");
    expect(anchorFor(home, "/")).toContain('data-active="true"');
    expect(anchorFor(home, "/")).not.toContain('data-active="false"');
    expect(anchorFor(home, "/sessions")).toContain('data-active="false"');
    expect(anchorFor(home, "/skills")).toContain('data-active="false"');
    expect(anchorFor(sessions, "/sessions")).toContain('data-active="true"');
    expect(anchorFor(sessions, "/")).toContain('data-active="false"');
    expect(anchorFor(skills, "/skills")).toContain('data-active="true"');
  });

  it("keeps the repository link external", async () => {
    const html = await renderShellAt("/");
    const repo = anchorFor(html, "https://github.com/Quick-Release/banquinha");
    expect(repo).toContain('target="_blank"');
    expect(repo).toContain('rel="noreferrer"');
  });
});
