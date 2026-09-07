import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TranscriptPage } from "./TranscriptPage";
import type { LlmSessionSummary, LlmTranscript } from "../schema";

// The transcript page's render contract (ticket #35): the session index,
// the ordered redacted conversation, per-turn metadata, and the redaction
// ledger — with no original path or credential surviving into the HTML.

const sessions: LlmSessionSummary[] = [
  {
    session_id: "sess_abc",
    requests: 2,
    models: ["claude-x"],
    input_tokens: 30,
    output_tokens: 12,
    cache_tokens: 5,
    first_at: "2026-09-08T10:00:00.000Z",
    last_at: "2026-09-08T10:05:00.000Z",
  },
];

const transcript: LlmTranscript = {
  session: "sess_abc",
  messages: [
    {
      role: "user",
      content:
        "look at /Users/ada/workbench/src/app.ts and https://token123@github.com/acme/widgets.git",
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "done — see /Users/ada/workbench/src/app.ts" }],
    },
  ],
  turns: [
    {
      request_id: "req_001",
      turn_id: "turn_1",
      model: "claude-x",
      status: "ok",
      http_status: 200,
      input_tokens: 10,
      output_tokens: 7,
      duration_ms: 410,
      received_at: "2026-09-08T10:00:00.000Z",
    },
    {
      request_id: "req_002",
      turn_id: null,
      model: "claude-x",
      status: "error",
      http_status: 529,
      input_tokens: 20,
      output_tokens: null,
      duration_ms: 1200,
      received_at: "2026-09-08T10:05:00.000Z",
    },
  ],
};

const empty = { sessions: [], selectedSession: null, transcript: null, onSelectSession: () => {} };

// renderToString interleaves JSX text-boundary markers; strip them so
// assertions read like the rendered text.
const textOf = (html: string) => html.replaceAll("<!-- -->", "");

describe("TranscriptPage", () => {
  it("explains itself when nothing is captured yet", () => {
    const html = renderToString(<TranscriptPage {...empty} />);
    expect(html).toContain("No sessions captured yet");
  });

  it("renders the session index with aggregate stats", () => {
    const html = textOf(
      renderToString(<TranscriptPage {...empty} sessions={sessions} selectedSession="sess_abc" />),
    );
    expect(html).toContain("sess_abc");
    expect(html).toContain("2 requests · 42 tokens");
    expect(html).toContain("claude-x");
  });

  it("renders ordered messages, per-turn metadata, and redacted tokens with the ledger", () => {
    const html = textOf(
      renderToString(
        <TranscriptPage
          {...empty}
          sessions={sessions}
          selectedSession="sess_abc"
          transcript={transcript}
          onSelectSession={() => {}}
        />,
      ),
    );
    // The conversation, in order.
    expect(html.indexOf("look at")).toBeGreaterThan(-1);
    expect(html.indexOf("done — see")).toBeGreaterThan(html.indexOf("look at"));
    // Turn metadata table: the turn id when present, the request id when not.
    expect(html).toContain("turn_1");
    expect(html).toContain("req_002");
    expect(html).toContain("410 ms");
    expect(html).toContain("error (529)");
    // Stable redaction tokens and the ledger, with no originals anywhere.
    expect(html).toContain("[REDACTED-PATH-1]");
    expect(html).toContain("[REDACTED-CREDENTIAL-URL-1]");
    expect(html).toContain("Redaction ledger");
    expect(html).toContain("2 occurrences redacted");
    expect(html).not.toContain("/Users/ada/workbench");
    expect(html).not.toContain("token123");
  });
});
