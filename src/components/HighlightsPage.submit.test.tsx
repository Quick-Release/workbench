// @vitest-environment happy-dom
import { deepStrictEqual, strictEqual } from "node:assert";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { HighlightsPage } from "./HighlightsPage";
import { submitHighlight } from "../lib/submissions";
import type { CommitCandidate } from "../types";

// The interactive half of the Submit coverage (ticket #18): a real click on
// a rendered Submit button drives the real submission client, and the
// network boundary sees exactly the seam's contract — however richer the
// candidate the page holds, nothing beyond the five schema fields leaves.

const candidate: CommitCandidate = {
  sha: "sha-18",
  subject: "feat: candidate 18",
  body: "Why it changed, Refs: #18",
  author: "Ada Lovelace",
  date: "2026-09-03T10:00:00.000Z",
  ticketRef: "#18",
};

describe("clicking Submit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs exactly the submission contract to the localhost seam", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        ({ status: 200, json: async () => ({ ok: true }) }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <HighlightsPage highlights={[candidate]} onSubmit={(next) => submitHighlight(next)} />,
      );
    });

    const button = container.querySelector<HTMLButtonElement>('button[data-sha="sha-18"]');
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    strictEqual(fetchMock.mock.calls.length, 1);
    const [url, init] = fetchMock.mock.calls[0];
    strictEqual(url, "/api/submissions");
    strictEqual(init.method, "POST");
    deepStrictEqual(JSON.parse(String(init.body)), {
      sha: "sha-18",
      subject: "feat: candidate 18",
      body: "Why it changed, Refs: #18",
      author: "Ada Lovelace",
      ticketRef: "#18",
    });
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
