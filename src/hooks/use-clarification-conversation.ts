import { useCallback, useEffect, useRef, useState } from "react";

import {
  parseClarificationConversationCommandResult,
  parseClarificationConversationState,
  parseClarificationRunResult,
  type ClarificationConversationCommand,
} from "../schema";
import type {
  ClarificationConversationCommandResult,
  ClarificationConversationState,
  ClarificationRunResult,
} from "../types";

// The managed conversation surface's client (spec #221, ticket #232): one
// hook per issue panel. It finds the issue's run (a 404 is the honest
// no-run answer, not a failure), reads the run section plus the live
// conversation state, and subscribes to the attempt's SSE stream so new
// ledger events reload the reads. The Developer's commands travel with
// caller-chosen request ids so a retried submission can never double-send
// an accepted prompt.

export type ClarificationCommandError = { error: string; message: string };

export const useClarificationConversation = (issueNumber: number | null) => {
  const [section, setSection] = useState<ClarificationRunResult | null>(null);
  const [conversationState, setConversationState] = useState<ClarificationConversationState | null>(
    null,
  );
  const [absent, setAbsent] = useState(issueNumber === null);
  const [failure, setFailure] = useState<string | null>(null);
  // The attempt whose stream this viewer follows; it only changes when the
  // section's attempts change, so the effect below can key on it.
  const [streamAttempt, setStreamAttempt] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (issueNumber === null) return;
    try {
      const response = await fetch(`/api/clarification/run?issue=${issueNumber}`);
      if (response.status === 404) {
        setAbsent(true);
        setSection(null);
        return;
      }
      if (!response.ok) {
        setFailure(`the run read answered ${response.status}`);
        return;
      }
      const parsed = parseClarificationRunResult((await response.json()) as unknown);
      runIdRef.current = parsed.run.runId;
      setAbsent(false);
      setFailure(null);
      setSection(parsed);
      // The live state read rides the newest non-terminal attempt — the one
      // a conversation is happening on.
      const live = parsed.attempts.find((attempt) => attempt.state !== "terminal");
      if (live) {
        setStreamAttempt(live.attemptId);
        const stateResponse = await fetch(
          `/api/clarification/runs/${parsed.run.runId}/attempts/${live.attemptId}/conversation`,
        );
        if (stateResponse.ok)
          setConversationState(
            parseClarificationConversationState((await stateResponse.json()) as unknown),
          );
        else setConversationState(null);
      } else {
        setStreamAttempt(null);
        setConversationState(null);
      }
    } catch {
      // The seam is unreachable (or this is a static build): the surface
      // stays absent rather than pretending.
      setFailure("the clarification seam is unreachable");
    }
  }, [issueNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live observation: one SSE subscription per followed attempt. A frame is
  // only a hint that the ledger moved — the refetch is the read.
  useEffect(() => {
    if (streamAttempt === null || runIdRef.current === null) return;
    const runId = runIdRef.current;
    let source: EventSource;
    try {
      source = new EventSource(`/api/clarification/runs/${runId}/attempts/${streamAttempt}/events`);
    } catch {
      // No EventSource here (static build, old test host): the refetch on
      // every command still keeps the surface honest.
      return;
    }
    source.onmessage = () => {
      void load();
    };
    return () => {
      source.close();
    };
  }, [streamAttempt, load]);

  // The caller names the request id — one id per user submission, kept
  // stable across retries until the seam definitively answers. That is the
  // reconnect fence's other half: the ledger dedups the id, so a retry of
  // an ambiguous submission can never double-send an accepted prompt.
  const sendCommand = useCallback(
    async (
      runId: string,
      attemptId: string,
      command: ClarificationConversationCommand,
      requestId: string,
    ): Promise<ClarificationConversationCommandResult | ClarificationCommandError> => {
      try {
        const response = await fetch(
          `/api/clarification/runs/${runId}/attempts/${attemptId}/commands`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId, command }),
          },
        );
        const body: unknown = (await response.json()) as unknown;
        if (!response.ok) {
          const typed = body as { error?: string; message?: string };
          return {
            error: typed.error ?? "command_failed",
            message: typed.message ?? `the command answered ${response.status}`,
          };
        }
        return parseClarificationConversationCommandResult(body);
      } catch {
        return { error: "unreachable", message: "the clarification seam is unreachable" };
      }
    },
    [],
  );

  return { section, conversationState, absent, failure, reload: load, sendCommand };
};
