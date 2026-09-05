import { useEffect, useState } from "react";

import { overviewData } from "../data";
import { workflowStateFrom } from "../lib/workflow-state";
import { parseWorkflowStatePayload } from "../schema";
import type { WorkflowStatePayload } from "../types";

// The bundled snapshot paints the first render and serves static builds; the
// execution seam's live read replaces it when the dev server answers. An
// unreachable seam degrades nothing — the snapshot simply stays and the
// consumer learns the seam is static.
const initialWorkflowState = workflowStateFrom(overviewData);

type WorkflowAtom = {
  state: WorkflowStatePayload;
  mode: "live" | "static";
};

// One shared atom behind the hooks (ticket #64): the header chip and the
// route pages must see the same state, so a sync or a panel action pushes
// its re-read result here and every consumer re-renders from it.
let current: WorkflowAtom = { state: initialWorkflowState, mode: "live" };
const listeners = new Set<(next: WorkflowAtom) => void>();

const emit = (next: WorkflowAtom) => {
  current = next;
  for (const listener of listeners) listener(next);
};

// Writes only ever happen through a live seam answer — a pushed state is the
// action's re-read result, so mode stays live.
export const setWorkflowState = (state: WorkflowStatePayload) => emit({ state, mode: "live" });

let liveReadStarted = false;

const readLiveState = () => {
  if (liveReadStarted) return;
  liveReadStarted = true;
  void (async () => {
    try {
      const response = await fetch("/api/workflow");
      if (!response.ok) throw new Error(String(response.status));
      emit({ state: parseWorkflowStatePayload(await response.json()), mode: "live" });
    } catch {
      emit({ state: current.state, mode: "static" });
    }
  })();
};

const useWorkflowAtom = (): WorkflowAtom => {
  const [atom, setAtom] = useState<WorkflowAtom>(current);

  useEffect(() => {
    listeners.add(setAtom);
    readLiveState();
    return () => {
      listeners.delete(setAtom);
    };
  }, []);

  return atom;
};

export const useWorkflowState = (): WorkflowStatePayload => useWorkflowAtom().state;

export const useWorkflowMode = (): "live" | "static" => useWorkflowAtom().mode;
