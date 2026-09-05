import { useState } from "react";
import { createFileRoute, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { IssueDetailPanel, type IssuePanelAction } from "../components/IssueDetailPanel";
import { OverviewPage } from "../components/OverviewPage";
import { overviewData } from "../data";
import { useWorkflowMode, useWorkflowState, setWorkflowState } from "../hooks/use-workflow-state";
import { issueParamFromSearch, panelIdFor } from "../lib/issue-param";
import {
  parseIssueCommentResult,
  parseIssueCreateResult,
  parseIssueEditResult,
  parseSyncTriggerResult,
} from "../schema";

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
  // The detail panel's param (ticket #60): `?issue=NN` / `?issue=new`,
  // validated by the shared grammar the other views use.
  issue: z.string().catch(""),
});

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...searchSchema.parse(search),
    issue: issueParamFromSearch(search),
  }),
  search: {
    middlewares: [
      stripSearchParams({ q: "", status: "all", source: "all", stream: "all", view: "all" }),
    ],
  },
  component: WorkbenchRoute,
});

// Each panel action posts exactly its seam schema's fields — the action's
// `kind` picks the route and never crosses the wire, where it would be excess.
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

function WorkbenchRoute() {
  const legacySearch = Route.useSearch();
  const search = {
    q: legacySearch.q,
    status: legacySearch.status,
    source: legacySearch.source,
    stream: legacySearch.stream,
    view: legacySearch.view,
  };
  const navigate = useNavigate({ from: Route.fullPath });
  const updateSearch = (next: Partial<typeof search>) =>
    void navigate({
      search: (previous) => ({ ...previous, ...next }),
      replace: true,
    });

  // The shared workflow atom (see use-workflow-state): the header chip and
  // this page read one state, so syncs and panel actions update both.
  const state = useWorkflowState();
  const mode = useWorkflowMode();
  const [syncPending, setSyncPending] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncWarnings, setSyncWarnings] = useState<readonly string[]>([]);
  const [panelPending, setPanelPending] = useState<IssuePanelAction["kind"] | null>(null);
  const [panelMessage, setPanelMessage] = useState<string | null>(null);
  const issueParam = Route.useSearch({ select: (s) => s.issue });
  const panelIssueId = panelIdFor(issueParam);

  const setIssueParam = (issue: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, issue }) });

  const sync = async () => {
    setSyncPending(true);
    setSyncMessage(null);
    setSyncWarnings([]);
    try {
      const response = await fetch("/api/workflow/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setSyncMessage(failure ?? `The sync was rejected (${response.status}).`);
        return;
      }
      const result = parseSyncTriggerResult(raw);
      setWorkflowState(result.state);
      setSyncMessage(result.message);
      setSyncWarnings(result.warnings);
    } catch {
      setSyncMessage("The sync did not go through — the dev server API is not reachable.");
    } finally {
      setSyncPending(false);
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
      if ("state" in result) setWorkflowState(result.state);
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
      <OverviewPage
        data={overviewData}
        search={search}
        onSearchChange={updateSearch}
        resetSearch={() =>
          void navigate({
            search: (previous) => ({
              ...previous,
              q: "",
              status: "all",
              source: "all",
              stream: "all",
              view: "all",
            }),
            replace: true,
          })
        }
        state={state}
        mode={mode}
        onOpenIssue={(issueId) => setIssueParam(issueId.slice(3))}
        onSync={() => void sync()}
        syncPending={syncPending}
        syncMessage={syncMessage}
        syncWarnings={syncWarnings}
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
