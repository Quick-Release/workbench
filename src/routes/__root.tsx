import { Outlet, createRootRoute } from "@tanstack/react-router";

import { overviewData } from "@/data";
import { AppShell } from "@/components/layout/app-shell";

export const Route = createRootRoute({
  component: () => (
    <AppShell meta={overviewData.meta}>
      <Outlet />
    </AppShell>
  ),
});
