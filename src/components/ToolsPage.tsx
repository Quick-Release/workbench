import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

type ToolId = "fallow" | "renovate";

type ApiTool = {
  id: ToolId;
  name: string;
  summary: string;
  docsUrl: string;
  setup: "api";
};

type ManualTool = {
  id: string;
  name: string;
  summary: string;
  docsUrl: string;
  setup: "manual";
};

type ToolCatalogEntry = ApiTool | ManualTool;

const CATALOG: ToolCatalogEntry[] = [
  {
    id: "fallow",
    name: "Fallow",
    summary:
      "Codebase intelligence for TypeScript: dead code, circular dependencies, duplication, and complexity hotspots. Deterministic and free.",
    docsUrl: "https://github.com/fallow-rs/fallow",
    setup: "api",
  },
  {
    id: "renovate",
    name: "Renovate",
    summary:
      "Automated dependency-update PRs with grouping that keeps the Effect RC and alchemy beta pins from drifting silently.",
    docsUrl: "https://docs.renovatebot.com",
    setup: "api",
  },
  {
    id: "coderabbit",
    name: "CodeRabbit",
    summary:
      "AI code review on every PR. Free tier on private repos is summary-only; full reviews are paid per seat.",
    docsUrl: "https://coderabbit.ai",
    setup: "manual",
  },
];

type StatusMap = Partial<Record<ToolId, boolean>>;

const ToolsPage = () => {
  const [statuses, setStatuses] = useState<StatusMap>({});
  const [unavailable, setUnavailable] = useState(false);
  const [pending, setPending] = useState<ToolId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/tools");
      if (!response.ok) throw new Error(String(response.status));
      const { tools } = (await response.json()) as { tools: { id: ToolId; configured: boolean }[] };
      setStatuses(Object.fromEntries(tools.map((tool) => [tool.id, tool.configured])));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setUp = async (id: ToolId) => {
    setPending(id);
    setMessage(null);
    try {
      const response = await fetch(`/api/tools/${id}/setup`, { method: "POST" });
      const body = (await response.json()) as {
        message?: string;
        tools?: { id: ToolId; configured: boolean }[];
      };
      if (body.tools) {
        setStatuses(Object.fromEntries(body.tools.map((tool) => [tool.id, tool.configured])));
      }
      setMessage(body.message ?? (response.ok ? "Done." : "Setup failed."));
    } catch {
      setMessage("Setup failed: the dev server API is not reachable.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-2">
        <Wrench className="size-5 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Tools</h1>
      </div>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Recommended developer-experience tools for this repository. Setup runs against the dev
        server's working tree.
      </p>
      {unavailable && (
        <p className="text-sm text-muted-foreground">
          Tool status is unavailable — the tools API only exists when the workbench runs via
          <code className="mx-1 rounded bg-muted px-1">pnpm dev</code>.
        </p>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {CATALOG.map((tool) => (
          <Card key={tool.id} className="flex flex-col">
            <CardHeader>
              <CardTitle>{tool.name}</CardTitle>
              <CardDescription>{tool.summary}</CardDescription>
            </CardHeader>
            <CardFooter className="mt-auto justify-between">
              {tool.setup === "manual" ? (
                <a
                  href={tool.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
                >
                  Install via GitHub App <ExternalLink className="size-3" />
                </a>
              ) : (
                <>
                  <Badge variant={statuses[tool.id] ? "secondary" : "outline"}>
                    {statuses[tool.id] === undefined
                      ? "…"
                      : statuses[tool.id]
                        ? "Configured"
                        : "Not set up"}
                  </Badge>
                  <Button
                    size="sm"
                    disabled={unavailable || pending !== null || statuses[tool.id]}
                    onClick={() => void setUp(tool.id)}
                  >
                    {pending === tool.id ? "Setting up…" : "Set up"}
                  </Button>
                </>
              )}
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
};

export { ToolsPage };
