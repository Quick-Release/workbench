import { parseReviewRunEvent, type ReviewRunEvent } from "@/schema";
import type { ReviewEngine } from "@/types";

// The review-run client (ticket #26): the browser half of the execution
// seam. A run starts as a POST whose response body is the runner's event
// stream (server-sent events), parsed frame by frame; a cancel is a plain
// POST. Only engine + pr ever travel — the server assembles everything else.

export class ReviewRunHttpError extends Error {
  status: number;
  payload: { error?: string; message?: string } | null;

  constructor(status: number, payload: { error?: string; message?: string } | null) {
    super(payload?.message ?? `review run failed with status ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

export const streamReviewRun = async function* ({
  engine,
  pr,
  fetchImpl = fetch,
}: {
  engine: ReviewEngine;
  pr: number;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<ReviewRunEvent> {
  const response = await fetchImpl("/api/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine, pr }),
  });
  if (!response.ok) {
    // Rejection payloads (busy, unknown PR) are best-effort display strings:
    // the typed seam contract covers the run's events, so a malformed
    // rejection only degrades the message the panel can show.
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ReviewRunHttpError(response.status, payload);
  }

  // Server-sent events, read frame by frame: each frame is one line of
  // `data: <json>` followed by a blank line.
  const reader = response.body?.getReader();
  if (!reader) throw new ReviewRunHttpError(response.status ?? 0, null);
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
      if (line) yield parseReviewRunEvent(JSON.parse(line.slice("data: ".length)));
      boundary = buffer.indexOf("\n\n");
    }
  }
};

export const cancelReviewRun =
  (fetchImpl: typeof fetch = fetch) =>
  async (engine: ReviewEngine): Promise<void> => {
    await fetchImpl("/api/review/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine }),
    });
  };
