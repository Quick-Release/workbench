import { useState } from "react";

import { parseSyncTriggerResult } from "../schema";
import { setWorkflowState } from "./use-workflow-state";

// The manual sync trigger's runner (GH-145): the header trigger and the
// overview's sync section post the same empty sync request through the seam
// and push the re-read state into the shared workflow atom — a completed run
// refreshes stamp, warnings, and state everywhere the atom is read. The
// pending/message/warnings display stays per surface; what every trigger
// shares is the module-level in-flight guard: one sync at a time, whichever
// trigger started it.
let inFlight = false;

export const useSyncTrigger = () => {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);

  const sync = async () => {
    if (inFlight) return;
    inFlight = true;
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
      inFlight = false;
      setPending(false);
    }
  };

  return { pending, message, warnings, sync };
};
