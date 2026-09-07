import { useMemo } from "react";

import { redactTranscript } from "@/lib/redact";
import type { LlmSessionSummary, LlmTranscript } from "../schema";

// The session-capture transcript page (ticket #35): one captured session,
// rendered turn by turn with per-turn metadata, redacted at render time —
// raw bodies stay raw in R2, and the redaction ledger travels with the
// conversation so nothing leaks when the page is read or shared. The page
// is presentational: sessions and the selected transcript arrive as props,
// which keeps it server-render testable in all its states.

interface TranscriptPageProps {
  sessions: readonly LlmSessionSummary[];
  selectedSession: string | null;
  transcript: LlmTranscript | null;
  onSelectSession: (sessionId: string) => void;
}

export function TranscriptPage({
  sessions,
  selectedSession,
  transcript,
  onSelectSession,
}: TranscriptPageProps) {
  const { messages, ledger } = useMemo(
    () => redactTranscript(transcript?.messages ?? []),
    [transcript],
  );

  return (
    <div className="flex h-full">
      <aside className="w-80 shrink-0 border-r p-4">
        <h2 className="mb-3 text-sm font-semibold">Captured sessions</h2>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sessions captured yet — point a coding agent at the capture proxy to record one.
          </p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((session) => (
              <li key={session.session_id}>
                <button
                  type="button"
                  onClick={() => onSelectSession(session.session_id)}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
                    session.session_id === selectedSession ? "bg-accent" : ""
                  }`}
                >
                  <span className="block truncate font-medium">{session.session_id}</span>
                  <span className="block text-xs text-muted-foreground">
                    {session.requests} requests · {session.input_tokens + session.output_tokens}{" "}
                    tokens · {session.models.join(", ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="min-w-0 flex-1 overflow-auto p-4">
        {transcript === null ? (
          <p className="text-sm text-muted-foreground">Select a session to read its transcript.</p>
        ) : (
          <>
            <h1 className="mb-3 text-lg font-semibold">Transcript · {transcript.session}</h1>
            <table className="mb-6 w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Turn</th>
                  <th className="py-1 pr-3 font-medium">Model</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 pr-3 font-medium">Tokens in/out</th>
                  <th className="py-1 pr-3 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {transcript.turns.map((turn) => (
                  <tr key={turn.request_id} className="border-b last:border-0">
                    <td className="py-1 pr-3">{turn.turn_id ?? turn.request_id}</td>
                    <td className="py-1 pr-3">{turn.model}</td>
                    <td className="py-1 pr-3">
                      {turn.status}
                      {turn.http_status !== null ? ` (${turn.http_status})` : ""}
                    </td>
                    <td className="py-1 pr-3">
                      {turn.input_tokens ?? "–"} / {turn.output_tokens ?? "–"}
                    </td>
                    <td className="py-1 pr-3">
                      {turn.duration_ms !== null ? `${turn.duration_ms} ms` : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="space-y-3">
              {messages.map((message, index) => (
                <article key={index} className="rounded-md border p-3">
                  <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                    {message.role}
                  </p>
                  <div className="whitespace-pre-wrap text-sm">
                    {renderContent(message.content)}
                  </div>
                </article>
              ))}
            </div>

            <section className="mt-6 rounded-md border bg-muted/40 p-3">
              <h2 className="mb-1 text-sm font-semibold">Redaction ledger</h2>
              {ledger.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing redacted in this transcript.
                </p>
              ) : (
                <ul className="text-sm text-muted-foreground">
                  {ledger.map((entry) => (
                    <li key={entry.token}>
                      <code>{entry.token}</code> — {entry.kind}, {entry.count}{" "}
                      {entry.count === 1 ? "occurrence" : "occurrences"} redacted
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block && typeof block.text === "string"
          ? block.text
          : `[${(block as { type?: string }).type ?? "block"}]`,
      )
      .join("\n");
  }
  return "";
}
