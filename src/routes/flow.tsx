import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { FlowPage } from "../components/FlowPage";
import { overviewData } from "../data";
import { parseSkillsStatus } from "../schema";
import type { SkillsStatus } from "../types";

const searchSchema = z.object({
  favorites: z.boolean().catch(false),
  skill: z.string().trim().max(80).catch(""),
});

export const Route = createFileRoute("/flow")({
  validateSearch: searchSchema,
  search: {
    middlewares: [stripSearchParams({ favorites: false, skill: "" })],
  },
  component: FlowRoute,
});

function FlowRoute() {
  const [status, setStatus] = useState<SkillsStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const updateSearch = (next: Partial<typeof search>) =>
    void navigate({
      search: (previous) => ({ ...previous, ...next }),
      replace: true,
    });

  // Installed state is read per request through the execution seam; when no
  // dev server answers, FlowPage degrades to the snapshot (ADR 0005/0006).
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/skills");
      if (!response.ok) throw new Error(String(response.status));
      setStatus(parseSkillsStatus(await response.json()));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async (verb: string, id: string) => {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/skills/${id}/${verb}`, { method: "POST" });
      // Error bodies may carry only a message; decode what arrives.
      let body: SkillsStatus | null = null;
      try {
        body = parseSkillsStatus(await response.json());
      } catch {
        body = null;
      }
      if (body) setStatus(body);
      setMessage(
        !response.ok
          ? (body?.message ?? `Install failed (${response.status}).`)
          : (body?.message ?? `Installed ${id}.`),
      );
    } catch {
      setMessage("Install failed — the dev server did not answer.");
    } finally {
      setPending(false);
    }
  };

  return (
    <FlowPage
      data={overviewData}
      status={status}
      pending={pending}
      message={message}
      favorites={search.favorites}
      selected={search.skill || null}
      onFavoritesChange={(favorites) => updateSearch({ favorites })}
      onSelect={(skill) => updateSearch({ skill: skill ?? "" })}
      onInstall={(id) => void install("install", id)}
      onInstallAll={() => void install("setup", "matt-pocock")}
    />
  );
}
