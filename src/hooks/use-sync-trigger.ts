import { useState } from "react";

import { parseSyncTriggerResult } from "../schema";
import { setWorkflowState } from "./use-workflow-state";

// The manual sync trigger's one runner (GH-145): the header trigger and the
// overview's sync section share one pending/message/warnings shell, post the
// empty sync request through the seam, and push the re-read state into the
// shared atom — a completed run refreshes stamp, warnings, and state together.
export const useSyncTrigger = () => {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);

  const sync = async () => {
    setPending(true);
    setMessage(null);
    setWarnings([]);
    try {
      const response = await fetch("/api/workflow/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const { message: failure } = (raw ?? {}) as { message?: string };
        setMessage(failure ?? `The sync was rejected (${response.status}).`);
        return;
      }
      const result = parseSyncTriggerResult(raw);
      setWorkflowState(result.state);
      setMessage(result.message);
      setWarnings(result.warnings);
    } catch {
      setMessage("The sync did not go through — the dev server API is not reachable.");
    } finally {
      setPending(false);
    }
  };

  return { pending, message, warnings, sync };
};
