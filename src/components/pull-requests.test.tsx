import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DraftPanel } from "./DraftPanel";
import { PullRequestsPage } from "./PullRequestsPage";
import { draftingState, idleState, mapDraftResponse } from "../lib/draft-state";
import type { PullRequestRecord } from "../types";

const pr = (number: number, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/Quick-Release/workbench/pull/${number}`,
  head: "agent/zcode/draft-panel",
  base: "main",
  author: "vvaz",
  isDraft: false,
  body: "What and why.",
  ...overrides,
});

const renderPage = (
  pullRequests: readonly PullRequestRecord[] = [pr(82)],
  aiConfigured: boolean | null = null,
) => renderToString(<PullRequestsPage pullRequests={pullRequests} aiConfigured={aiConfigured} />);

describe("the draft panel states, passed as data props", () => {
  it("renders the idle state as an empty panel", () => {
    const html = renderToString(<DraftPanel state={idleState} />);
    expect(html).toContain('data-draft-state="idle"');
    expect(html).not.toContain("Drafting");
    expect(html).not.toContain("Copy draft");
  });

  it("renders a visible drafting state", () => {
    const html = renderToString(<DraftPanel state={draftingState} />);
    expect(html).toContain('data-draft-state="drafting"');
    expect(html).toContain("Drafting description…");
    expect(html).toContain('aria-busy="true"');
  });

  it("renders the done state with a copyable title and body", () => {
    const state = mapDraftResponse(200, { title: "The title", body: "The body text" });
    const html = renderToString(<DraftPanel state={state} />);
    expect(html).toContain('data-draft-state="done"');
    expect(html).toContain("The title");
    expect(html).toContain("The body text");
    expect(html).toContain("Copy draft");
  });

  it("renders failures as a readable error", () => {
    const state = mapDraftResponse(502, {
      error: "provider_error",
      message: "the provider rejected the call",
    });
    const html = renderToString(<DraftPanel state={state} />);
    expect(html).toContain('data-draft-state="error"');
    expect(html).toContain("the provider rejected the call");
  });

  it("renders the unconfigured state as a configuration hint", () => {
    const html = renderToString(<DraftPanel state={mapDraftResponse(503, null)} />);
    expect(html).toContain('data-draft-state="unconfigured"');
    expect(html).toContain("ANTHROPIC_API_KEY");
    expect(html).toContain("pnpm dev");
  });
});

describe("the pull-requests page", () => {
  it("renders the review-engines health panel from the runner's verdict", () => {
    const html = renderToString(
      <PullRequestsPage
        pullRequests={[pr(82)]}
        aiConfigured={null}
        engineHealth={[
          { engine: "coderabbit", state: "ready", version: "coderabbit 1.2.3" },
          {
            engine: "zcode",
            state: "provider_missing",
            version: "0.16.5",
            remediation: "run `zcode login` to configure a model provider",
          },
        ]}
      />,
    );
    expect(html).toContain('data-slot="review-engines"');
    expect(html).toContain('data-engine-state="ready"');
    expect(html).toContain("run `zcode login` to configure a model provider");
  });

  it("lists each open pull request with its coordinates and a draft action", () => {
    const html = renderPage([pr(82), pr(78, { title: "AI middleware", isDraft: true })]);
    expect(html).toContain('data-pr="82"');
    expect(html).toContain('data-pr="78"');
    expect(html).toContain("Pull request 82");
    expect(html).toContain('href="https://github.com/Quick-Release/workbench/pull/82"');
    // React SSR sprinkles comment markers between interpolations; strip them
    // so the head → base rendering reads as one string.
    const flat = html.replace(/<!-- -->/g, "");
    expect(flat).toContain("agent/zcode/draft-panel → main");
    expect((flat.match(/Draft description/g) ?? []).length).toBe(2);
    expect((flat.match(/data-slot="badge"/g) ?? []).length).toBe(1);
  });

  it("sends nothing on its own — the page renders idle with no panel and no drafting marker", () => {
    const html = renderPage();
    expect(html).not.toContain('data-draft-state="drafting"');
    expect(html).not.toContain('data-slot="draft-panel"');
  });

  it("renders the empty state when no pull requests are collected", () => {
    const html = renderPage([]);
    expect(html).toContain("No open pull requests collected yet");
  });

  it("renders the configuration hint instead of enabled actions when no key is set", () => {
    const html = renderPage([pr(82)], false);
    expect(html).toContain('data-slot="ai-unconfigured"');
    expect(html).toContain("ANTHROPIC_API_KEY");
    const row = html.slice(html.indexOf('data-pr="82"'));
    expect(row).toContain('disabled=""');
  });

  it("keeps the draft action enabled while the health probe is unknown or configured", () => {
    for (const aiConfigured of [null, true]) {
      const html = renderPage([pr(82)], aiConfigured);
      expect(html).not.toContain('data-slot="ai-unconfigured"');
      const row = html.slice(html.indexOf('data-pr="82"'));
      const draftButton = row.slice(row.indexOf("Draft description") - 400);
      expect(draftButton).not.toContain('disabled=""');
    }
  });

  it("holds the review actions off until each engine's health verdict says ready", () => {
    // Ticket #24's invariant, from the other side: with no verdict yet, a
    // review cannot be started at all — the buttons wait for the probe.
    const html = renderPage([pr(82)], null);
    expect(html).toContain('title="coderabbit is not ready to run a review"');
    expect(html).toContain('title="zcode is not ready to run a review"');
  });
});
