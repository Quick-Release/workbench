import { useCallback, useEffect, useRef, useState } from "react";

import {
  parseClarificationDraftView,
  parseClarificationPublicationResult,
  parseClarificationRunResult,
  type ClarificationPublicationResult,
} from "../schema";
import { rememberOwnRequest } from "../lib/clarification-viewer";
import type { ClarificationDraftDocument, ClarificationDraftView } from "../types";
import type { ClarificationCommandError } from "./use-clarification-conversation";

// The Clarification draft's client (spec #221, ticket #233): one hook per
// issue panel. It finds the issue's run the way the conversation surface
// does (a 404 is the honest no-run answer), reads the newest attempt's
// draft, and saves corrections as a PUT of the whole document — the draft
// is one mutable proposal, latest write wins, and the answer is the fresh
// view with its completeness arithmetic and the visible diff. Saving is
// never approval: the request has no approval field to set.
export const useClarificationDraft = (issueNumber: number | null) => {
  const [view, setView] = useState<ClarificationDraftView | null>(null);
  const [absent, setAbsent] = useState(issueNumber === null);
  const [failure, setFailure] = useState<string | null>(null);
  const targetRef = useRef<{ runId: string; attemptId: string } | null>(null);

  const load = useCallback(async () => {
    if (issueNumber === null) return;
    try {
      const runResponse = await fetch(`/api/clarification/run?issue=${issueNumber}`);
      if (runResponse.status === 404) {
        setAbsent(true);
        setView(null);
        return;
      }
      if (!runResponse.ok) {
        setFailure(`the run read answered ${runResponse.status}`);
        return;
      }
      const section = parseClarificationRunResult((await runResponse.json()) as unknown);
      // The newest attempt still worth talking to — a retry supersedes its
      // predecessors, and the draft follows the attempt a conversation is
      // happening on. An all-terminal run falls back to the last one, whose
      // record stays inspectable.
      const candidates = section.attempts.filter((candidate) => candidate.state !== "terminal");
      const pool = candidates.length > 0 ? candidates : section.attempts;
      const attempt = pool[pool.length - 1];
      if (!attempt) {
        setFailure("the run holds no attempt");
        return;
      }
      targetRef.current = { runId: section.run.runId, attemptId: attempt.attemptId };
      const draftResponse = await fetch(
        `/api/clarification/runs/${section.run.runId}/attempts/${attempt.attemptId}/draft`,
      );
      if (!draftResponse.ok) {
        setFailure(`the draft read answered ${draftResponse.status}`);
        return;
      }
      setView(parseClarificationDraftView((await draftResponse.json()) as unknown));
      setAbsent(false);
      setFailure(null);
    } catch {
      // The seam is unreachable (or this is a static build): the surface
      // stays absent rather than pretending.
      setFailure("the clarification seam is unreachable");
    }
  }, [issueNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (
      draft: ClarificationDraftDocument,
    ): Promise<ClarificationDraftView | ClarificationCommandError> => {
      const target = targetRef.current;
      if (!target)
        return { error: "no_attempt", message: "no clarification attempt holds a draft" };
      try {
        const response = await fetch(
          `/api/clarification/runs/${target.runId}/attempts/${target.attemptId}/draft`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(draft),
          },
        );
        const body: unknown = (await response.json()) as unknown;
        if (!response.ok) {
          const typed = body as { error?: string; message?: string };
          return {
            error: typed.error ?? "save_failed",
            message: typed.message ?? `the save answered ${response.status}`,
          };
        }
        const parsed = parseClarificationDraftView(body);
        setView(parsed);
        return parsed;
      } catch {
        return { error: "unreachable", message: "the clarification seam is unreachable" };
      }
    },
    [],
  );

  // The one publication (ticket #234), wired as the action matrix's fresh
  // approval (ticket #237): the request presents exactly what the view
  // displayed — the diff's digest and the revision it was rendered against
  // — so a draft edited after viewing can never ride this approval.
  const approve = useCallback(
    async (
      shown: ClarificationDraftView,
      requestId: string,
    ): Promise<ClarificationPublicationResult | ClarificationCommandError> => {
      if (!shown.issue || !shown.publicationBodyDigest)
        return { error: "no_diff", message: "there is no visible diff to approve" };
      rememberOwnRequest(requestId);
      try {
        const response = await fetch(
          `/api/clarification/runs/${shown.runId}/attempts/${shown.attemptId}/publication`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              requestId,
              revision: shown.issue.revision,
              bodyDigest: shown.publicationBodyDigest,
            }),
          },
        );
        const body: unknown = (await response.json()) as unknown;
        if (!response.ok) {
          const typed = body as { error?: string; message?: string };
          return {
            error: typed.error ?? "publication_failed",
            message: typed.message ?? `the publication answered ${response.status}`,
          };
        }
        return parseClarificationPublicationResult(body);
      } catch {
        return { error: "unreachable", message: "the clarification seam is unreachable" };
      }
    },
    [],
  );

  return { view, absent, failure, reload: load, save, approve };
};
