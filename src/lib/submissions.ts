// The Submission client (ticket #12): the browser's one localhost call —
// the dev server holds the ingest token and forwards to the Worker, so no
// credential ever reaches the page (ADR 0001).

export interface HighlightCandidateInput {
  sha: string;
  subject: string;
  body: string;
  author: string;
  ticketRef: string;
}

export type SubmissionOutcome = {
  status: "submitted" | "duplicate" | "failed";
  message: string;
};

export function submissionOutcomeFromResponse(
  status: number,
  body: { ok?: boolean; error?: string },
): SubmissionOutcome {
  if (status === 200 && body.ok) {
    return { status: "submitted", message: "Submitted — thank you! It is in the review queue." };
  }
  if (status === 409) {
    return { status: "duplicate", message: "This commit message was already submitted." };
  }
  return { status: "failed", message: body.error ?? "The submission could not be delivered." };
}

export async function submitHighlight(
  candidate: HighlightCandidateInput,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<SubmissionOutcome> {
  try {
    const response = await fetchImpl("/api/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidate),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return submissionOutcomeFromResponse(response.status, body);
  } catch (error) {
    return { status: "failed", message: String((error as Error)?.message ?? error) };
  }
}
