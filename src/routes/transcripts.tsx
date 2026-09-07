import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { TranscriptPage } from "../components/TranscriptPage";
import { parseLlmSessions, parseLlmTranscript } from "../schema";
import type { LlmSessionSummary, LlmTranscript } from "../schema";

export const Route = createFileRoute("/transcripts")({
  component: TranscriptsRoute,
});

// The session-capture route (ticket #35): fetches the captured-session
// index from the dev-server capture API on mount, then one transcript per
// selected session — bodies are fetched on demand rather than synced into
// the generated data snapshot, keeping the snapshot light. An unreachable
// or malformed payload leaves the page empty rather than guessing (the
// payload passes the Effect Schema boundary, ADR 0005).
function TranscriptsRoute() {
  const [sessions, setSessions] = useState<readonly LlmSessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<LlmTranscript | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/llm/sessions");
        if (!response.ok) return;
        setSessions(parseLlmSessions(await response.json()).sessions);
      } catch {
        setSessions([]);
      }
    })();
  }, []);

  const onSelectSession = useCallback((sessionId: string) => {
    setSelectedSession(sessionId);
    setTranscript(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/llm/sessions/${encodeURIComponent(sessionId)}/transcript`,
        );
        if (!response.ok) return;
        setTranscript(parseLlmTranscript(await response.json()));
      } catch {
        setTranscript(null);
      }
    })();
  }, []);

  return (
    <TranscriptPage
      sessions={sessions}
      selectedSession={selectedSession}
      transcript={transcript}
      onSelectSession={onSelectSession}
    />
  );
}
