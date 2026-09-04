import { createFileRoute } from "@tanstack/react-router";

import { ToolsPage } from "../components/ToolsPage";

export const Route = createFileRoute("/tools")({
  component: ToolsRoute,
});

function ToolsRoute() {
  return <ToolsPage />;
}
