import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { IssueDetailPanel, type IssuePanelAction } from "../components/IssueDetailPanel";
import { TriagePage, type TriageLens } from "../components/TriagePage";
import { overviewData } from "../data";
import { issueParamFromSearch, panelIdFor } from "../lib/issue-param";
import { workflowStateFrom } from "../lib/workflow-state";
import {
  parseIssueCommentResult,
  parseIssueCreateResult,
  parseIssueEditResult,
  parseTriageMoveResult,
  parseWorkflowStatePayload,
} from "../schema";
import type { TriageState, WorkflowStatePayload } from "../types";

type TriageSearch = { lens?: TriageLens; issue?: string };

// The bundled snapshot paints the first render and serves static builds;
// the execution seam's live read replaces it when the dev server answers.
const initialState: WorkflowStatePayload = workflowStateFrom(overviewData);

export const Route = createFileRoute("/triage")({
  validateSearch: (search: Record<string, unknown>): TriageSearch => ({
    lens: search.lens === "wontfix" ? "wontfix" : undefined,
    issue: issueParamFromSearch(search),
  }),
  component: TriageRoute,
});

// Each action posts exactly its seam schema's fields — the action's `kind`
// picks the route and never crosses the wire, where it would be excess.
const payloadFor = (action: IssuePanelAction) => {
  switch (action.kind) {
    case "comment":
      return { issueId: action.issueId, body: action.body };
    case "edit":
      return {
        issueId: action.issueId,
        title: action.title,
        body: action.body,
        confirm: action.confirm,
      };
    case "create":
      return { title: action.title, body: action.body };
  }
};

const RESULT_PARSERS = {
  comment: parseIssueCommentResult,
  edit: parseIssueEditResult,
  create: parseIssueCreateResult,
} as const;

function TriageRoute() {
  const [state, setState] = useState(initialState);
  const [mode, setMode] = useState<"live" | "static">("live");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [panelPending, setPanelPending] = useState<IssuePanelAction["kind"] | null>(null);
  const [panelMessage, setPanelMessage] = useState<string | null>(null);
  const lens = Route.useSearch({ select: (search) => search.lens ?? "none" });
  const issueParam = Route.useSearch({ select: (search) => search.issue });
  const navigate = Route.useNavigate();
  const panelIssueId = panelIdFor(issueParam);

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

  const setIssueParam = (issue: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, issue }) });

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

  const runIssueAction = async (action: IssuePanelAction) => {
    setPanelPending(action.kind);
    setPanelMessage(null);
    try {
      const response = await fetch(`/api/workflow/issue/${action.kind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payloadFor(action)),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setPanelMessage(failure ?? `The action was rejected (${response.status}).`);
        return;
      }
      const result = RESULT_PARSERS[action.kind](raw);
      if ("state" in result) setState(result.state);
      setPanelMessage(result.message);
      if (action.kind === "create") setIssueParam(result.issueId.slice(3));
    } catch {
      setPanelMessage("The action did not go through — the dev server API is not reachable.");
    } finally {
      setPanelPending(null);
    }
  };

  return (
    <>
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
        onOpenIssue={(issueId) => setIssueParam(issueId.slice(3))}
        onNewIssue={() => setIssueParam("new")}
        pendingId={pendingId}
        message={message}
      />
      <IssueDetailPanel
        issueId={panelIssueId}
        state={state}
        mode={mode}
        pending={panelPending}
        message={panelMessage}
        onOpenChange={(open) => {
          if (!open) setIssueParam(undefined);
        }}
        onAction={(action) => void runIssueAction(action)}
      />
    </>
  );
}
