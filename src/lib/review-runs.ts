import { parseReviewRunEvent, type ReviewRunEvent } from "@/schema";
import { startDenialReasons, type Engine, type StartDenialReason } from "@/types";

// The run client (ticket #26; issue #40): the browser half of the execution
// seam. A run starts as a POST whose response body is the runner's event
// stream (server-sent events), parsed frame by frame; a cancel is a plain
// POST. Only the enumerated request ever travels — engine, target number,
// and for the agent an optional model — the server assembles everything else.

// A rejection's payload: the seam's typed shapes (run_busy, and the bug
// gate's denial with its repository-scoped blocking references) degrade to
// display strings only when malformed.
export type ReviewRunRejection = {
  error?: string;
  message?: string;
  blocking?: readonly { id: string; title: string; url: string }[];
};

export class ReviewRunHttpError extends Error {
  status: number;
  payload: ReviewRunRejection | null;

  constructor(status: number, payload: ReviewRunRejection | null) {
    super(payload?.message ?? `review run failed with status ${status}`);
    this.status = status;
    this.payload = payload;
  }

  // The bug gate's denial (ADR 0012): the message plus the open client bugs
  // blocking, spelled out so the panel shows what holds the start. Only the
  // gate's typed reasons count — run_busy and friends stay plain messages.
  denialMessage(): string | null {
    const payload = this.payload;
    const reason = payload?.error;
    if (!payload || !reason || !startDenialReasons.includes(reason as StartDenialReason))
      return null;
    const refs = (payload.blocking ?? []).map((bug) => `${bug.id} "${bug.title}"`).join(", ");
    return refs ? `${payload.message} Blocking: ${refs}.` : (payload.message ?? null);
  }
}

export const streamReviewRun = async function* ({
  engine,
  pr,
  issue,
  model,
  signal,
  fetchImpl = fetch,
}: {
  engine: Engine;
  pr?: number;
  issue?: number;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<ReviewRunEvent> {
  const response = await fetchImpl("/api/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      engine,
      ...(pr !== undefined ? { pr } : {}),
      ...(issue !== undefined ? { issue } : {}),
      ...(model !== undefined ? { model } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    // Rejection payloads (busy, unknown PR, the bug gate's denial) are
    // best-effort typed: the typed seam contract covers the run's events, so
    // a malformed rejection only degrades the message the panel can show.
    const payload = (await response.json().catch(() => null)) as ReviewRunRejection | null;
    throw new ReviewRunHttpError(response.status, payload);
  }

  // Server-sent events, read frame by frame: each frame is one line of
  // `data: <json>` followed by a blank line. An early exit — the consumer
  // stopping, or a malformed event — releases the reader, so the connection
  // is not left open behind a generator nobody is draining.
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ReviewRunHttpError(response.status ?? 0, {
      error: "empty_stream",
      message: "the review endpoint answered with no event stream",
    });
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
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
  } finally {
    reader.cancel().catch(() => {});
  }
};

export const cancelReviewRun =
  (fetchImpl: typeof fetch = fetch) =>
  async (engine: Engine): Promise<void> => {
    const response = await fetchImpl("/api/review/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      throw new ReviewRunHttpError(response.status, payload);
    }
  };
