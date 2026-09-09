// @vitest-environment happy-dom
import { deepStrictEqual, strictEqual } from "node:assert";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PullRequestsRoute } from "./pull-requests";

// The route's own contract (ticket #24): on load it probes both health
// endpoints through the localhost seam and hands the verdicts down as data.
// A probe that fails leaves the verdict unknown — the page degrades rather
// than guessing — and the fetches stay literal /api/ calls (ADR 0005).

const reviewHealth = {
  engines: [
    { engine: "coderabbit", state: "ready", version: "coderabbit 1.2.3" },
    {
      engine: "zcode",
      state: "provider_missing",
      version: "0.16.5",
      remediation: "run `zcode login` to configure a model provider",
    },
  ],
};

const renderRoute = async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PullRequestsRoute />);
  });
  await act(async () => {});
  return {
    html: () => container.innerHTML,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
};

describe("the pull-requests route on load", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes both health endpoints through the localhost seam", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        ({
          "/api/ai/health": { ok: true, status: 200, json: async () => ({ configured: false }) },
          "/api/review/health": { ok: true, status: 200, json: async () => reviewHealth },
        })[url] as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await renderRoute();
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain("/api/ai/health");
    expect(urls).toContain("/api/review/health");

    strictEqual(page.html().includes('data-engine-state="ready"'), true);
    strictEqual(page.html().includes('data-engine-state="provider_missing"'), true);
    strictEqual(page.html().includes("run `zcode login` to configure a model provider"), true);
    await page.unmount();
  });

  it("degrades to unknown when a health probe fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("dev server unreachable");
      }),
    );

    const page = await renderRoute();
    strictEqual(
      page.html().includes('data-slot="review-engines-unknown"'),
      true,
      "an unreachable probe stays unknown, never a guessed verdict",
    );
    strictEqual(page.html().includes("data-engine-state="), false);
    await page.unmount();
  });
});

// The review-run flow (ticket #26): the row's Review action starts a run
// through the seam, the panel streams the runner's events, and cancel hits
// the cancel endpoint — all with only engine + pr travelling.

const reviewHealthReady = {
  engines: [
    { engine: "coderabbit", state: "ready", version: "coderabbit 1.2.3" },
    { engine: "zcode", state: "ready", version: "0.16.5" },
  ],
};

const click = async (container: HTMLElement, selector: string) => {
  const target = container.querySelector<HTMLButtonElement>(selector);
  expect(target).toBeTruthy();
  await act(async () => {
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

describe("the pull-requests route's review flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mountWithHealth = async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/review/health") {
        return { ok: true, status: 200, json: async () => reviewHealthReady } as Response;
      }
      if (url === "/api/ai/health") {
        return { ok: true, status: 200, json: async () => ({ configured: false }) } as Response;
      }
      if (url === "/api/review") {
        // A run held open, so the panel is still running when Cancel is hit.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: "output", stream: "stdout", text: "finding one\n" })}\n\n`,
                ),
              );
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/review/cancel") {
        return { ok: true, status: 200, json: async () => ({ cancelled: true }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<PullRequestsRoute />);
    });
    await act(async () => {});
    return {
      calls,
      container,
      unmount: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  };

  it("starts a review from the row, streams its output, and cancels on demand", async () => {
    const page = await mountWithHealth();
    const row = page.container.querySelector('[data-slot="pull-request-row"]');
    expect(row).toBeTruthy();
    const pr = Number(row?.getAttribute("data-pr"));

    const reviewButton = [...(row?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("Review · coderabbit"),
    );
    expect(reviewButton).toBeTruthy();
    await act(async () => {
      reviewButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const startCall = page.calls.find((call) => call.url === "/api/review");
    expect(startCall).toBeTruthy();
    strictEqual(startCall?.init?.method, "POST");
    deepStrictEqual(JSON.parse(String(startCall?.init?.body)), { engine: "coderabbit", pr });

    const html = page.container.innerHTML;
    expect(html).toContain('data-slot="review-run"');
    expect(html).toContain("finding one");

    await click(page.container, '[data-slot="review-run"] button');
    const cancelCall = page.calls.find((call) => call.url === "/api/review/cancel");
    expect(cancelCall).toBeTruthy();
    deepStrictEqual(JSON.parse(String(cancelCall?.init?.body)), { engine: "coderabbit" });
    await page.unmount();
  });

  it("renders a busy rejection as the server's message", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === "/api/review/health") {
          return { ok: true, status: 200, json: async () => reviewHealthReady } as Response;
        }
        if (url === "/api/ai/health") {
          return { ok: true, status: 200, json: async () => ({ configured: false }) } as Response;
        }
        if (url === "/api/review") {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: "run_busy",
              message: "a coderabbit review is already running; cancel it or wait",
            }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<PullRequestsRoute />);
    });
    await act(async () => {});
    const row = container.querySelector('[data-slot="pull-request-row"]');
    const reviewButton = [...(row?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("Review · coderabbit"),
    );
    await act(async () => {
      reviewButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.innerHTML).toContain('data-slot="review-run-busy"');
    expect(container.innerHTML).toContain(
      "a coderabbit review is already running; cancel it or wait",
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
