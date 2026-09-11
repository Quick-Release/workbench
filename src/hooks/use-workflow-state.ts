import { useEffect, useState } from "react";

import { overviewData } from "../data";
import { nextRefreshDelayMs, shouldRefreshNow } from "../lib/live-refresh";
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

// The live refresh lifecycle (GH-136): the atom re-reads the seam on startup
// (the first mount's live read), on tab focus, after every pushed mutation
// (the actions' own re-reads), and on a bounded, coalesced interval while
// the tab is visible. Errors back off; the last successful check is
// reported, never silently stale. Static mode — no reachable seam — polls
// nothing.
export type LiveRefreshStatus = {
  lastCheckedAt: string | null;
  error: string | null;
};

let refreshStatus: LiveRefreshStatus = { lastCheckedAt: null, error: null };
const refreshListeners = new Set<(next: LiveRefreshStatus) => void>();

const emitRefreshStatus = () => {
  for (const listener of refreshListeners) listener(refreshStatus);
};

export const useLiveRefreshStatus = (): LiveRefreshStatus => {
  const [status, setStatus] = useState<LiveRefreshStatus>(refreshStatus);
  useEffect(() => {
    refreshListeners.add(setStatus);
    return () => {
      refreshListeners.delete(setStatus);
    };
  }, []);
  return status;
};

let refreshInFlight = false;
let consecutiveErrors = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshStarted = false;
let readSeq = 0;

const noteRefreshOutcome = (error: string | null) => {
  consecutiveErrors = error === null ? 0 : consecutiveErrors + 1;
  refreshStatus = {
    lastCheckedAt: error === null ? new Date().toISOString() : refreshStatus.lastCheckedAt,
    error,
  };
  emitRefreshStatus();
};

// One seam re-read. Coalesced (a read in flight swallows the trigger) and
// order-guarded: each read carries a sequence number, and a slow answer from
// an older request — or one whose repository no longer matches — never
// overwrites newer state (GH-136).
const refreshNow = async (): Promise<boolean> => {
  if (refreshInFlight) return false;
  refreshInFlight = true;
  const seq = ++readSeq;
  try {
    const response = await fetch("/api/workflow");
    if (!response.ok) throw new Error(`status ${response.status}`);
    const payload = parseWorkflowStatePayload(await response.json());
    if (seq === readSeq && payload.meta.repo === current.state.meta.repo)
      emit({ state: payload, mode: "live" });
    noteRefreshOutcome(null);
    return true;
  } catch (error) {
    noteRefreshOutcome(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    refreshInFlight = false;
  }
};

const scheduleNextRefresh = () => {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshTick(), nextRefreshDelayMs(consecutiveErrors));
};

const refreshTick = async () => {
  if (
    shouldRefreshNow({
      mode: current.mode,
      visible: typeof document === "undefined" || document.visibilityState === "visible",
      inFlight: refreshInFlight,
      dueAt: 0,
      now: 1,
    })
  )
    await refreshNow();
  scheduleNextRefresh();
};

const onVisibilityChange = () => {
  // Tab focus: refresh immediately (the coalescing guard applies), then keep
  // the cadence — a fresh answer meets the documented polling target while
  // the tab stays active.
  if (document.visibilityState === "visible" && current.mode === "live") void refreshNow();
};

export const startLiveRefresh = () => {
  if (refreshStarted || typeof window === "undefined") return;
  refreshStarted = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
  scheduleNextRefresh();
};

let liveReadStarted = false;

const readLiveState = () => {
  if (liveReadStarted) return;
  liveReadStarted = true;
  void (async () => {
    try {
      const response = await fetch("/api/workflow");
      if (!response.ok) throw new Error(String(response.status));
      emit({ state: parseWorkflowStatePayload(await response.json()), mode: "live" });
      noteRefreshOutcome(null);
      // The seam answered: the periodic lifecycle begins here.
      startLiveRefresh();
    } catch {
      emit({ state: current.state, mode: "static" });
      noteRefreshOutcome("the dev server API is not reachable");
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
