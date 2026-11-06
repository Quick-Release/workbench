import { useState } from "react";
import { Square, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReviewRunState } from "@/lib/review-run-state";
import type { RetainedAgentRun, ReviewEngineHealth } from "@/types";

// The issue-agent panel (issue #40): one card that takes an issue number and
// a model, starts the agent, and renders the run's typed event stream — the
// review panel's mirror, with notices and a draft-PR verdict of its own.
// Everything arrives as data: the engine's health verdict gates the start
// affordance, and the state board (src/lib/review-run-state.ts) carries the
// run. The container fires the fetches; nothing here touches the network.

const exitVerdict = (run: ReviewRunState): string => {
  if (run.error) return run.error.message;
  if (run.failure) return run.failure;
  if (run.exit?.cancelled) return "Cancelled — any draft work stays in the kept worktree.";
  if (run.exit?.code === 0) return "Draft pull request opened for review.";
  return `The agent run exited with code ${run.exit?.code ?? "unknown"}.`;
};

// The retained runs (GH-116, ADR 0027): every run-owned worktree Git lists
// for this host repo. An active run cannot be discarded; a retained one is
// discarded with one click; a quarantined one (its lock outlived its owner)
// takes a second, explicit confirmation before the request carries
// confirmQuarantined.
const stateLabel: Record<RetainedAgentRun["state"], string> = {
  active: "active",
  retained: "retained",
  quarantined: "quarantined",
};

function RetainedRuns({
  runs,
  onDiscard,
  discardError,
}: {
  runs: readonly RetainedAgentRun[];
  onDiscard: (runId: string, confirmQuarantined: boolean) => void;
  discardError: string | null;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div data-slot="issue-agent-retained" className="mt-4">
      <p className="text-xs font-medium">Retained runs</p>
      <p className="text-xs text-muted-foreground">
        Failed and cancelled runs keep their worktree and local branch until you discard them.
        Discarding never touches the pushed branch or its pull request.
      </p>
      {runs.length === 0 ? (
        <p data-slot="issue-agent-retained-empty" className="mt-1 text-xs text-muted-foreground">
          No retained runs.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {runs.map((entry) => (
            <li
              key={entry.runId}
              data-slot="issue-agent-retained-run"
              data-run-state={entry.state}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span>issue #{entry.issue}</span>
              <span className="font-mono">{entry.runId}</span>
              <Badge variant="outline">{stateLabel[entry.state]}</Badge>
              <span className="w-full truncate font-mono text-muted-foreground" title={entry.path}>
                {entry.path}
              </span>
              {entry.state === "quarantined" && confirming === entry.runId ? (
                <>
                  <span className="text-amber-600 dark:text-amber-400">
                    Its lock outlived the process that made it. Discard anyway?
                  </span>
                  <Button
                    type="button"
                    data-slot="issue-agent-discard-confirm"
                    variant="destructive"
                    size="xs"
                    onClick={() => {
                      setConfirming(null);
                      onDiscard(entry.runId, true);
                    }}
                  >
                    Confirm discard
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  data-slot="issue-agent-discard"
                  variant="outline"
                  size="xs"
                  disabled={entry.state === "active"}
                  title={
                    entry.state === "active"
                      ? "this run is still going — cancel it or wait for it to end"
                      : undefined
                  }
                  onClick={() =>
                    entry.state === "quarantined"
                      ? setConfirming(entry.runId)
                      : onDiscard(entry.runId, false)
                  }
                >
                  <Trash2 aria-hidden />
                  Discard
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {discardError && (
        <p data-slot="issue-agent-discard-error" className="mt-2 text-xs text-destructive">
          {discardError}
        </p>
      )}
    </div>
  );
}

export function IssueAgentPanel({
  health,
  run,
  onStart,
  onCancel,
  retained = null,
  onDiscard = () => {},
  discardError = null,
}: {
  // The opencode engine's health verdict, or null while unknown.
  health: ReviewEngineHealth | null;
  run: ReviewRunState;
  onStart: (issue: number, model?: string) => void;
  onCancel: () => void;
  // This host repo's run-owned worktrees, or null while not fetched.
  retained?: readonly RetainedAgentRun[] | null;
  onDiscard?: (runId: string, confirmQuarantined: boolean) => void;
  discardError?: string | null;
}) {
  const ready = health?.state === "ready";
  const models = ready && "models" in health ? health.models : [];
  const defaultModel = ready && "defaultModel" in health ? health.defaultModel : undefined;
  const running = run.phase === "running";

  return (
    <Card data-slot="issue-agent">
      <CardHeader>
        <CardTitle>Issue agent</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Starts an unattended local-model run on a host-repo issue: a fresh worktree, a fenced
          agent, and a draft pull request for your review. Your own working tree is never touched.
        </p>
        {health && health.state !== "ready" && (
          <p data-slot="issue-agent-unready" className="mt-2 text-xs text-muted-foreground">
            {"remediation" in health
              ? health.remediation
              : health.state === "probe_error"
                ? health.message
                : null}
          </p>
        )}
        {health?.state === "ready" && "warning" in health && health.warning && (
          <p data-slot="issue-agent-warning" className="mt-2 text-xs text-muted-foreground">
            {health.warning}
          </p>
        )}
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const field = event.currentTarget.elements.namedItem("issue");
            if (!(field instanceof HTMLInputElement)) return;
            const issue = Number(field.value);
            if (!Number.isInteger(issue) || issue <= 0) return;
            const picker = event.currentTarget.elements.namedItem("model");
            // The picker lists the server's pulled models in Ollama's own
            // (bare) naming; the seam validates provider-qualified ids, so
            // the panel qualifies before anything travels.
            const model =
              picker instanceof HTMLSelectElement && picker.value
                ? `ollama/${picker.value}`
                : undefined;
            onStart(issue, model);
          }}
        >
          <input
            data-slot="issue-agent-input"
            name="issue"
            type="number"
            min={1}
            step={1}
            placeholder="Issue number"
            className="w-36 rounded-md border bg-transparent px-2 py-1 text-sm"
            disabled={running}
          />
          <select
            data-slot="issue-agent-model"
            name="model"
            className="rounded-md border bg-transparent px-2 py-1 text-sm"
            disabled={running || models.length === 0}
            defaultValue={defaultModel?.replace(/^ollama\//, "")}
          >
            {models.length === 0 ? (
              <option value="">no pulled models</option>
            ) : (
              models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))
            )}
          </select>
          <Button
            type="submit"
            data-slot="issue-agent-start"
            variant="outline"
            size="xs"
            disabled={!ready || running}
            title={
              !ready
                ? "the issue agent is not ready — see its health below"
                : running
                  ? "an agent run is already going — cancel it first"
                  : undefined
            }
          >
            Start agent run
          </Button>
        </form>
        {run.phase === "busy" && (
          <p data-slot="issue-agent-busy" className="mt-2 text-sm text-muted-foreground">
            {run.busyMessage}
          </p>
        )}
        {run.phase !== "idle" && run.phase !== "busy" && (
          <div data-slot="issue-agent-run" data-run-phase={run.phase} className="mt-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs">{run.engine}</span>
              <span className="text-xs text-muted-foreground">issue #{run.issue}</span>
              {running && <Badge variant="outline">running</Badge>}
              {run.phase === "done" && (
                <Badge
                  variant={
                    run.exit?.cancelled || run.failure || run.error || run.exit?.code !== 0
                      ? "outline"
                      : "default"
                  }
                >
                  {run.exit?.cancelled
                    ? "cancelled"
                    : run.error || run.failure || run.exit?.code !== 0
                      ? "failed"
                      : "done"}
                </Badge>
              )}
              {running && (
                <Button
                  type="button"
                  data-slot="issue-agent-cancel"
                  variant="outline"
                  size="xs"
                  className="ml-auto"
                  onClick={onCancel}
                >
                  <Square aria-hidden />
                  Cancel
                </Button>
              )}
            </div>
            {run.cancelError && (
              <p data-slot="issue-agent-cancel-error" className="mt-2 text-xs text-destructive">
                {run.cancelError}
              </p>
            )}
            {run.notices.length > 0 && (
              <ul data-slot="issue-agent-notices" className="mt-2 flex flex-col gap-1">
                {run.notices.map((notice, index) => (
                  <li
                    key={index}
                    data-slot="issue-agent-notice"
                    className="text-xs text-amber-600 dark:text-amber-400"
                  >
                    {notice}
                  </li>
                ))}
              </ul>
            )}
            {run.output.length > 0 && (
              <pre
                data-slot="issue-agent-output"
                className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs"
              >
                {run.output}
              </pre>
            )}
            {run.truncated && (
              <p data-slot="issue-agent-truncated" className="mt-1 text-xs text-muted-foreground">
                Output was longer than the cap and was cut off.
              </p>
            )}
            {run.error && running && (
              <p data-slot="issue-agent-error" className="mt-2 text-sm text-destructive">
                {run.error.message}
              </p>
            )}
            {run.phase === "done" && (
              <p data-slot="issue-agent-verdict" className="mt-2 text-sm">
                {exitVerdict(run)}
              </p>
            )}
          </div>
        )}
        {retained && (
          <RetainedRuns runs={retained} onDiscard={onDiscard} discardError={discardError} />
        )}
      </CardContent>
    </Card>
  );
}
