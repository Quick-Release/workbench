import { createFileRoute } from "@tanstack/react-router";

import { SkillsPage } from "../components/SkillsPage";

export const Route = createFileRoute("/skills")({
  component: SkillsRoute,
});

function SkillsRoute() {
  return <SkillsPage />;
}
