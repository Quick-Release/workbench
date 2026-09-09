import { Square } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ReviewRunState } from "@/lib/review-run-state";

// The review-run panel (ticket #26): what a run's lifecycle looks like on
// the page, rendered entirely from the run state handed in as data. A busy
// run renders the server's typed rejection as a message; a running run
// streams its output and offers the cancel affordance; a finished run keeps
// its output with the exit's verdict — including the truncation marker.

const exitVerdict = (run: ReviewRunState): string => {
  if (run.error) return run.error.message;
  if (run.failure) return run.failure;
  if (run.exit?.cancelled) return "Cancelled.";
  if (run.exit?.code === 0) return "Review finished.";
  return `Review exited with code ${run.exit?.code ?? "unknown"}.`;
};

export function ReviewRunPanel({
  run,
  onCancel,
}: {
  run: ReviewRunState;
  onCancel?: (engine: NonNullable<ReviewRunState["engine"]>) => void;
}) {
  if (run.phase === "idle") return null;
  return (
    <div
      data-slot="review-run"
      data-run-phase={run.phase}
      className="mt-2 rounded-md border bg-muted/30 p-3"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs">{run.engine}</span>
        <span className="text-xs text-muted-foreground">review of #{run.pr}</span>
        {run.phase === "running" && <Badge variant="outline">running</Badge>}
        {run.phase === "done" && (
          <Badge variant={run.exit?.cancelled || run.failure ? "outline" : "default"}>
            {run.exit?.cancelled ? "cancelled" : run.error || run.failure ? "failed" : "done"}
          </Badge>
        )}
        {run.phase === "running" && run.engine && onCancel && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={() => onCancel(run.engine as NonNullable<ReviewRunState["engine"]>)}
          >
            <Square aria-hidden />
            Cancel
          </Button>
        )}
      </div>
      {run.phase === "busy" && (
        <p data-slot="review-run-busy" className="mt-2 text-sm text-muted-foreground">
          {run.busyMessage}
        </p>
      )}
      {run.output.length > 0 && (
        <pre
          data-slot="review-run-output"
          className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs"
        >
          {run.output.join("")}
        </pre>
      )}
      {run.truncated && (
        <p data-slot="review-run-truncated" className="mt-1 text-xs text-muted-foreground">
          Output was longer than the cap and was cut off.
        </p>
      )}
      {run.phase === "done" && (
        <p data-slot="review-run-verdict" className="mt-2 text-sm">
          {exitVerdict(run)}
        </p>
      )}
    </div>
  );
}
