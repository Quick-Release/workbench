import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HighlightsPage } from "./HighlightsPage";
import type { CommitCandidate } from "../types";
import type { SubmissionOutcome } from "../lib/submissions";

const candidate = (n: number): CommitCandidate => ({
  sha: `sha-${n}`,
  subject: `feat: candidate ${n}`,
  body: `Why it changed, Refs: #${n}`,
  author: "Ada Lovelace",
  date: "2026-09-03T10:00:00.000Z",
  ticketRef: `#${n}`,
});

const renderPage = (
  highlights: readonly CommitCandidate[],
  options: {
    onSubmit?: (candidate: CommitCandidate) => Promise<SubmissionOutcome>;
    outcomes?: ReadonlyMap<string, SubmissionOutcome>;
  } = {},
) => renderToString(<HighlightsPage highlights={highlights} {...options} />);

describe("HighlightsPage", () => {
  it("renders the explainer card on every state of the page", () => {
    const html = renderPage([]);
    expect(html).toContain("Nothing leaves your machine");
    expect(html).toContain("Submission");
  });

  it("renders each candidate with its subject, body, author, date, and ticket reference", () => {
    const html = renderPage([candidate(11), candidate(12)]);
    expect(html).toContain("feat: candidate 11");
    expect(html).toContain("Why it changed, Refs: #11");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("2026-09-03");
    expect(html).toContain("#11");
    expect(html).toContain("feat: candidate 12");
  });

  it("renders the empty state when no commits match the heuristic", () => {
    const html = renderPage([]);
    expect(html).toContain("No commit-message candidates");
  });

  it("renders a Submit action per candidate that names its commit", () => {
    const html = renderPage([candidate(11)], {
      onSubmit: async () => ({ status: "submitted", message: "ok" }),
    });
    expect(html).toContain("Submit");
    expect(html).toContain('data-sha="sha-11"');
  });

  it("marks a submitted candidate instead of offering its button again", () => {
    const html = renderPage([candidate(11)], {
      onSubmit: async () => ({ status: "submitted", message: "ok" }),
      outcomes: new Map([["sha-11", { status: "submitted", message: "ok" }]]),
    });
    expect(html).toContain("Submitted");
    expect(html).not.toContain(">Submit<");
  });

  it("shows the failure or duplicate message on the candidate", () => {
    const html = renderPage([candidate(11)], {
      onSubmit: async () => ({
        status: "duplicate",
        message: "This commit message was already submitted.",
      }),
      outcomes: new Map([
        ["sha-11", { status: "duplicate", message: "This commit message was already submitted." }],
      ]),
    });
    expect(html).toContain("This commit message was already submitted.");
    expect(html).toContain("Submit");
  });
});
