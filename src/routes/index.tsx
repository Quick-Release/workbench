import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { overviewData } from "../data";
import { OverviewPage } from "../components/OverviewPage";

const statusSchema = z.enum([
  "all",
  "complete",
  "in-progress",
  "ready",
  "needs-development",
  "gated",
  "blocked",
  "planned",
  "deferred",
]);

const sourceSchema = z.enum(["all", "tickets", "plans", "specs"]);
const viewSchema = z.enum(["all", "grilling", "spec", "tickets", "implementation"]);

const searchSchema = z.object({
  q: z.string().trim().max(120).catch(""),
  status: statusSchema.catch("all"),
  source: sourceSchema.catch("all"),
  stream: z.string().trim().max(80).catch("all"),
  view: viewSchema.catch("all"),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  search: {
    middlewares: [
      stripSearchParams({ q: "", status: "all", source: "all", stream: "all", view: "all" }),
    ],
  },
  loader: () => overviewData,
  component: WorkbenchRoute,
});

function WorkbenchRoute() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const updateSearch = (next: Partial<typeof search>) =>
    void navigate({
      search: (previous) => ({ ...previous, ...next }),
      replace: true,
    });

  return (
    <OverviewPage
      data={data}
      search={search}
      onSearchChange={updateSearch}
      resetSearch={() =>
        void navigate({
          search: { q: "", status: "all", source: "all", stream: "all", view: "all" },
          replace: true,
        })
      }
    />
  );
}
