import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { TriagePage, type TriageLens } from "../components/TriagePage";
import { overviewData } from "../data";
import { workflowStateFrom } from "../lib/workflow-state";
import { parseTriageMoveResult, parseWorkflowStatePayload } from "../schema";
import type { TriageState, WorkflowStatePayload } from "../types";

type TriageSearch = { lens?: TriageLens };

// The bundled snapshot paints the first render and serves static builds;
// the execution seam's live read replaces it when the dev server answers.
const initialState: WorkflowStatePayload = workflowStateFrom(overviewData);

export const Route = createFileRoute("/triage")({
  validateSearch: (search: Record<string, unknown>): TriageSearch => ({
    lens: search.lens === "wontfix" ? "wontfix" : undefined,
  }),
  component: TriageRoute,
});

function TriageRoute() {
  const [state, setState] = useState(initialState);
  const [mode, setMode] = useState<"live" | "static">("live");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lens = Route.useSearch({ select: (search) => search.lens ?? "none" });
  const navigate = Route.useNavigate();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/workflow");
        if (!response.ok) throw new Error(String(response.status));
        const payload = parseWorkflowStatePayload(await response.json());
        if (cancelled) return;
        setState(payload);
        setMode("live");
      } catch {
        if (!cancelled) setMode("static");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const move = async (issueId: string, triageState: TriageState) => {
    setPendingId(issueId);
    setMessage(null);
    try {
      const response = await fetch("/api/workflow/triage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issueId,
          triageState,
          ...(triageState === "wontfix" ? { confirm: true } : {}),
        }),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setMessage(failure ?? `The move was rejected (${response.status}).`);
        return;
      }
      // The seam answers with the re-read state, so the row moves on the
      // next render without a manual reload.
      const result = parseTriageMoveResult(raw);
      setState(result.state);
      setMessage(result.message);
    } catch {
      setMessage("The move did not go through — the dev server API is not reachable.");
    } finally {
      setPendingId(null);
    }
  };

  return (
    <TriagePage
      workItems={state.workItems}
      maps={state.maps}
      blockerEdges={state.blockerEdges}
      mode={mode}
      lens={lens}
      onLensChange={(next) =>
        navigate({
          search: (prev) => ({ ...prev, lens: next === "wontfix" ? "wontfix" : undefined }),
        })
      }
      onMove={(issueId, triageState) => void move(issueId, triageState)}
      pendingId={pendingId}
      message={message}
    />
  );
}
