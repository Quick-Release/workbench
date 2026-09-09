import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import type { ReviewEngine, ReviewHistoryEntry } from "@/types";

// The session run history (ticket #27): every run this dev-server session
// finished, newest first — engine, PR, outcome, duration — with the run's
// streamed result one click away and a one-click re-run that starts a fresh
// run through the page's normal lifecycle. The list arrives as data (the
// page fetches it on load and after each run); nothing here is persisted —
// a dev-server restart is the history's reset.

const duration = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

const outcomeLabels: Record<ReviewHistoryEntry["outcome"], string> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed out",
};

export function ReviewHistoryPanel({
  history,
  onRerun,
}: {
  history: readonly ReviewHistoryEntry[] | null;
  onRerun: (pr: number, engine: ReviewEngine) => void;
}) {
  // A re-opened entry stays open until clicked again; the set survives the
  // list refetching because entries keep their session id.
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(new Set());
  if (history === null) return null;

  const toggle = (id: number) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div data-slot="review-history" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Review history</h2>
      {history.length === 0 ? (
        <p data-slot="review-history-empty" className="text-sm text-muted-foreground">
          No reviews yet in this dashboard session.
        </p>
      ) : (
        <ul className="flex flex-col">
          {history.map((entry) => (
            <li
              key={entry.id}
              data-history-entry={entry.id}
              className="flex flex-col gap-1 border-b py-2 last:border-b-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-history-open={entry.id}
                  className="flex items-center gap-2 text-left"
                  onClick={() => toggle(entry.id)}
                >
                  <span className="font-mono text-xs">{entry.engine}</span>
                  <span className="text-xs">#{entry.pr}</span>
                  <Badge variant={entry.outcome === "completed" ? "default" : "outline"}>
                    {outcomeLabels[entry.outcome]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {duration(entry.durationMs)}
                  </span>
                  {entry.truncated && (
                    <span className="text-xs text-muted-foreground">(truncated)</span>
                  )}
                </button>
                <button
                  type="button"
                  data-history-rerun={entry.id}
                  className="ml-auto text-xs text-muted-foreground underline underline-offset-2"
                  onClick={() => onRerun(entry.pr, entry.engine)}
                >
                  Re-run
                </button>
              </div>
              {openIds.has(entry.id) && (
                <pre
                  data-history-output={entry.id}
                  className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs"
                >
                  {entry.output}
                  {entry.message ? `\n${entry.message}\n` : ""}
                  {entry.truncated ? "\n… the output was truncated at the run's cap\n" : ""}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
