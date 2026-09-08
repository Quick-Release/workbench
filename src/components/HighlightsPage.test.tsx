import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HighlightsPage } from "./HighlightsPage";
import type { CommitCandidate } from "../types";

const candidate = (n: number): CommitCandidate => ({
  sha: `sha-${n}`,
  subject: `feat: candidate ${n}`,
  body: `Why it changed, Refs: #${n}`,
  author: "Ada Lovelace",
  date: "2026-09-03T10:00:00.000Z",
  ticketRef: `#${n}`,
});

const renderPage = (highlights: readonly CommitCandidate[]) =>
  renderToString(<HighlightsPage highlights={highlights} />);

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
    const submitted = new Set<string>();
    const html = renderToString(
      <HighlightsPage
        highlights={[candidate(11)]}
        onSubmit={async () => ({ status: "submitted", message: "ok" })}
        submitted={submitted}
      />,
    );
    expect(html).toContain("Submit");
    expect(html).toContain('data-sha="sha-11"');
  });

  it("marks a submitted candidate instead of offering its button again", () => {
    const html = renderToString(
      <HighlightsPage
        highlights={[candidate(11)]}
        onSubmit={async () => ({ status: "submitted", message: "ok" })}
        submitted={new Set(["sha-11"])}
      />,
    );
    expect(html).toContain("Submitted");
    expect(html).not.toContain(">Submit<");
  });
});
