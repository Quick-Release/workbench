import { useState } from "react";

import type { IssuePanelAction } from "../components/IssueDetailPanel";
import { issueActionBody, issueActionRoute, parseIssueActionResult } from "../lib/issue-actions";
import { workItemIdNumberText } from "../lib/work-item-id";
import type { WorkflowStatePayload } from "../types";
import { setWorkflowState } from "./use-workflow-state";

// The shared panel's action runner (tickets #60/#61): one pending/message
// shell behind every route host, so the panel behaves identically on every
// view — post exactly the wire grammar's fields through the /api/-relative
// seam route, push the re-read state into the shared atom (plus whatever
// local state the host keeps), and degrade to a plain message when the dev
// server is unreachable.
export const useIssueActionRunner = () => {
  const [pending, setPending] = useState<IssuePanelAction["kind"] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (
    action: IssuePanelAction,
    onState?: (state: WorkflowStatePayload) => void,
    onCreated?: (issueId: string) => void,
  ) => {
    setPending(action.kind);
    setMessage(null);
    try {
      const response = await fetch(`/api/workflow/${issueActionRoute(action)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(issueActionBody(action)),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setMessage(failure ?? `The action was rejected (${response.status}).`);
        return;
      }
      const result = parseIssueActionResult(action.kind, raw);
      if ("state" in result) {
        setWorkflowState(result.state);
        onState?.(result.state);
      }
      setMessage(result.message);
      if (action.kind === "create" && "issueId" in result)
        onCreated?.(workItemIdNumberText(result.issueId));
    } catch {
      setMessage("The action did not go through — the dev server API is not reachable.");
    } finally {
      setPending(null);
    }
  };

  return { pending, message, run };
};
