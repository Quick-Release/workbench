import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { overviewData } from "../data";
import { SessionsPage } from "../components/SessionsPage";

const lensSchema = z.enum(["all", "interactive", "subagents", "handoffs"]);

const searchSchema = z.object({
  subagents: lensSchema.catch("all"),
});

export const Route = createFileRoute("/sessions")({
  validateSearch: searchSchema,
  search: {
    middlewares: [stripSearchParams({ subagents: "all" })],
  },
  loader: () => overviewData,
  component: SessionsRoute,
});

function SessionsRoute() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const updateSearch = (next: Partial<typeof search>) =>
    void navigate({
      search: (previous) => ({ ...previous, ...next }),
      replace: true,
    });

  return <SessionsPage data={data} search={search} onSearchChange={updateSearch} />;
}
