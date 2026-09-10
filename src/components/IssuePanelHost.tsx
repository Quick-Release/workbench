import { useIssueActionRunner } from "../hooks/use-issue-actions";
import { useWorkflowMode, useWorkflowState } from "../hooks/use-workflow-state";
import { panelIdFor } from "../lib/issue-param";

import { IssueDetailPanel } from "./IssueDetailPanel";

// One host behind the shared panel (tickets #60/#61): the route owns the
// `?issue` param and its navigation; the host wires the workflow atom's
// state and mode, the action runner, and the panel's props, so the panel
// behaves identically on every view.
export function IssuePanelHost({
  issueParam,
  onParamChange,
  onCreated,
}: Readonly<{
  issueParam: string | undefined;
  onParamChange: (issue: string | undefined) => void;
  onCreated?: (issueId: string) => void;
}>) {
  const state = useWorkflowState();
  const mode = useWorkflowMode();
  const { pending, message, run } = useIssueActionRunner();
  return (
    <IssueDetailPanel
      issueId={panelIdFor(issueParam)}
      state={state}
      mode={mode}
      pending={pending}
      message={message}
      onOpenChange={(open) => {
        if (!open) onParamChange(undefined);
      }}
      onAction={(action) => void run(action, undefined, onCreated)}
    />
  );
}
