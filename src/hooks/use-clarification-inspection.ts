import { useCallback, useEffect, useState } from "react";

import {
  parseClarificationInspectionResult,
  parseClarificationManifestResult,
  parseClarificationRunActionResult,
  parseClarificationStartResult,
  type ClarificationRunAction,
} from "../schema";
import { rememberOwnRequest } from "../lib/clarification-viewer";
import type {
  ClarificationInspectionResult,
  ClarificationManifestResult,
  ClarificationRunActionResult,
  ClarificationStartResult,
} from "../types";

// The run inspection's client (spec #221, ticket #237): the inspection read
// behind the panel-per-axis status (lease, usage, escalations, readiness),
// re-read whenever the run's ledger moves; the run actions of the action
// matrix; and the manifest read plus start that every fresh approval —
// start and retry — renders first. Every write carries a request id this
// tab remembers as its own, the one honest per-tab ownership fact.

export type SeamError = { error: string; message: string };

const failureOf = async (response: Response): Promise<SeamError> => {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return {
      error: body.error ?? "failed",
      message: body.message ?? `the seam answered ${response.status}`,
    };
  } catch {
    return { error: "failed", message: `the seam answered ${response.status}` };
  }
};

const unreachable: SeamError = {
  error: "unreachable",
  message: "the clarification seam is unreachable",
};

export const useClarificationInspection = (runId: string | null, latestCursor: number) => {
  const [inspection, setInspection] = useState<ClarificationInspectionResult | null>(null);

  const load = useCallback(async () => {
    if (runId === null) return;
    try {
      const response = await fetch(`/api/clarification/runs/${runId}/inspection`);
      // Anything but a clean answer leaves the axes unknown — the word,
      // never a stale green.
      if (!response.ok) {
        setInspection(null);
        return;
      }
      setInspection(parseClarificationInspectionResult((await response.json()) as unknown));
    } catch {
      setInspection(null);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load, latestCursor]);

  const runAction = useCallback(
    async (
      action: ClarificationRunAction,
      requestId: string,
    ): Promise<ClarificationRunActionResult | SeamError> => {
      if (runId === null) return { error: "no_run", message: "no clarification run is loaded" };
      rememberOwnRequest(requestId);
      try {
        const response = await fetch(`/api/clarification/runs/${runId}/actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, action }),
        });
        if (!response.ok) return await failureOf(response);
        return parseClarificationRunActionResult((await response.json()) as unknown);
      } catch {
        return unreachable;
      }
    },
    [runId],
  );

  return { inspection, reload: load, runAction };
};

// The fixed pre-start manifest, re-rendered for every fresh approval.
export const fetchClarificationManifest = async (
  issueNumber: number,
): Promise<ClarificationManifestResult | SeamError> => {
  try {
    const response = await fetch(`/api/clarification/manifest?issue=${issueNumber}`);
    if (!response.ok) return await failureOf(response);
    return parseClarificationManifestResult((await response.json()) as unknown);
  } catch {
    return unreachable;
  }
};

// The explicit start on the visible manifest. A denial still lands a
// durable run record (awaiting-human), so the caller reloads either way.
export const startClarification = async (
  issueNumber: number,
  manifest: ClarificationManifestResult,
  requestId: string,
): Promise<ClarificationStartResult | SeamError> => {
  rememberOwnRequest(requestId);
  try {
    const response = await fetch("/api/clarification/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue: issueNumber, requestId, revision: manifest.issue.revision }),
    });
    if (!response.ok) return await failureOf(response);
    return parseClarificationStartResult((await response.json()) as unknown);
  } catch {
    return unreachable;
  }
};
