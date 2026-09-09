// @vitest-environment happy-dom
import { strictEqual } from "node:assert";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ReviewCommentAction } from "./ReviewCommentAction";

// Ticket #25's UI contract: a completed review's findings offer a visible
// post action, but nothing is ever sent without the explicit confirmation
// beat — cancelling out of it unwinds to idle and the endpoint is never
// called. The fetch stays a literal /api/ call at its use (ADR 0005), and
// the network boundary sees exactly the seam's contract.

const renderAction = async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ReviewCommentAction
        engine="coderabbit"
        pr={25}
        findings={"## Findings\n\n- the login form leaks the token"}
      />,
    );
  });
  return { container, unmount: () => act(async () => root.unmount()) };
};

const click = async (container: HTMLElement, selector: string) => {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

describe("the post-as-comment action", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens with the visible post action and nothing sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = await renderAction();
    expect(container.querySelector('[data-review-comment-state="idle"]')).toBeTruthy();
    expect(container.querySelector('[data-review-comment-action="post"]')).toBeTruthy();
    strictEqual(fetchMock.mock.calls.length, 0);
  });

  it("posts only from the confirmation, with exactly the seam contract", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        ({
          status: 200,
          json: async () => ({
            message: "Review findings posted to PR #25.",
            engine: "coderabbit",
            pr: 25,
            commentUrl: "https://github.com/Quick-Release/workbench/pull/25#issuecomment-9",
          }),
        }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container, unmount } = await renderAction();

    await click(container, '[data-review-comment-action="post"]');
    expect(container.querySelector('[data-review-comment-state="confirming"]')).toBeTruthy();
    strictEqual(fetchMock.mock.calls.length, 0);

    await click(container, '[data-review-comment-action="confirm-post"]');
    strictEqual(fetchMock.mock.calls.length, 1);
    const [url, init] = fetchMock.mock.calls[0];
    strictEqual(url, "/api/review/comment");
    strictEqual(init.method, "POST");
    expect(JSON.parse(String(init.body))).toEqual({
      engine: "coderabbit",
      pr: 25,
      findings: "## Findings\n\n- the login form leaks the token",
    });

    expect(container.querySelector('[data-review-comment-state="posted"]')).toBeTruthy();
    const link = container.querySelector<HTMLAnchorElement>("a[data-review-comment-link]");
    expect(link?.href).toBe("https://github.com/Quick-Release/workbench/pull/25#issuecomment-9");
    await unmount();
  });

  it("cancelling out of the confirmation sends nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container, unmount } = await renderAction();

    await click(container, '[data-review-comment-action="post"]');
    await click(container, '[data-review-comment-action="cancel"]');

    expect(container.querySelector('[data-review-comment-state="idle"]')).toBeTruthy();
    strictEqual(fetchMock.mock.calls.length, 0);
    await unmount();
  });

  it("a missing gh login surfaces as its one-step fix, not a silent failure", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        ({
          status: 422,
          json: async () => ({
            error: "gh_auth_missing",
            remediation: "run `gh auth login` to authenticate the GitHub CLI",
          }),
        }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container, unmount } = await renderAction();

    await click(container, '[data-review-comment-action="post"]');
    await click(container, '[data-review-comment-action="confirm-post"]');

    const error = container.querySelector('[data-slot="review-comment-error"]');
    expect(error).toBeTruthy();
    expect(error?.textContent).toContain("gh auth login");
    await unmount();
  });
});
