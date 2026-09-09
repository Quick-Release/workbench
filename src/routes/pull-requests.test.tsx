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
    // One run at a time: with the stream still open, further review starts
    // are held off so the running panel and its cancel affordance survive.
    const reviewWhileRunning = [...(row?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("Review · zcode"),
    );
    expect(reviewWhileRunning?.disabled).toBe(true);

    await click(page.container, '[data-slot="review-run"] button');
    const cancelCall = page.calls.find((call) => call.url === "/api/review/cancel");
    expect(cancelCall).toBeTruthy();
    deepStrictEqual(JSON.parse(String(cancelCall?.init?.body)), { engine: "coderabbit" });
    await page.unmount();
  });

  it("replays a cancellation that raced the run's registration", async () => {
    // The cancel POST can land before the start POST has claimed its engine;
    // the benign no_run answer must not swallow the intent — it replays the
    // moment the run registers (its first event arrives).
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const calls: { url: string; init?: RequestInit }[] = [];
    let cancelCalls = 0;
    const encoder = new TextEncoder();
    let startController: ReadableStreamDefaultController<Uint8Array> | null = null;
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
          return new Response(
            new ReadableStream({
              start(controller) {
                startController = controller;
                // No events yet: the run is still claiming its engine.
              },
            }),
            { status: 200 },
          );
        }
        if (url === "/api/review/cancel") {
          cancelCalls += 1;
          if (cancelCalls === 1) {
            return {
              ok: false,
              status: 404,
              json: async () => ({ error: "no_run", message: "no active coderabbit review" }),
            } as Response;
          }
          return { ok: true, status: 200, json: async () => ({ cancelled: true }) } as Response;
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
    const unmount = async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    };

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

    // The cancel fires while the run is still registering: it is refused
    // with the benign no_run, and the intent is kept.
    await click(container, '[data-slot="review-run"] button');
    strictEqual(cancelCalls, 1);

    // The run registers — its first event arrives — and the kept intent
    // replays as a real cancel.
    await act(async () => {
      startController?.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "started", engine: "coderabbit", pr: 82 })}\n\n`,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    strictEqual(cancelCalls, 2, "the kept cancellation intent replayed on registration");
    const replay = calls.filter((call) => call.url === "/api/review/cancel").at(-1);
    deepStrictEqual(JSON.parse(String(replay?.init?.body)), { engine: "coderabbit" });

    // The replayed cancel lands: the runner's cancelled exit closes it out.
    await act(async () => {
      startController?.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "exit", code: null, signal: "SIGTERM", cancelled: true })}\n\n`,
        ),
      );
      startController?.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.innerHTML).toContain("cancelled");
    await unmount();
  });

  it("lists the session's finished runs, re-opens a result, and re-runs through the normal start", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const calls: { url: string; init?: RequestInit }[] = [];
    let historyFetches = 0;
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
        if (url === "/api/review/history") {
          historyFetches += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              runs: [
                {
                  id: 9,
                  engine: "zcode",
                  pr: 7,
                  outcome: "completed",
                  durationMs: 12500,
                  output: "zcode findings\n",
                  truncated: false,
                  message: null,
                },
              ],
            }),
          } as Response;
        }
        if (url === "/api/review") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: "exit", code: 0, signal: null, cancelled: false })}\n\n`,
                  ),
                );
                controller.close();
              },
            }),
            { status: 200 },
          );
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const unmount = async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    };

    // The finished run lists with its outcome and duration.
    expect(container.innerHTML).toContain('data-history-entry="9"');
    expect(container.innerHTML).toContain("zcode");
    expect(container.innerHTML).toContain("completed");
    expect(container.innerHTML).toContain("12.5s");
    strictEqual(historyFetches, 1);

    // Re-run is the page's normal start path: engine + pr, nothing else.
    await click(container, '[data-history-rerun="9"]');
    const start = calls.find((call) => call.url === "/api/review" && call.init?.method === "POST");
    expect(start).toBeTruthy();
    deepStrictEqual(JSON.parse(String(start?.init?.body)), { engine: "zcode", pr: 7 });

    // The rerun's stream ends, and the page refetches the history.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    strictEqual(historyFetches, 2, "the history refetches when a run ends");
    await unmount();
  });

  it("answers an empty session history with its own empty state", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/review/health") {
          return { ok: true, status: 200, json: async () => reviewHealthReady } as Response;
        }
        if (url === "/api/ai/health") {
          return { ok: true, status: 200, json: async () => ({ configured: false }) } as Response;
        }
        if (url === "/api/review/history") {
          return { ok: true, status: 200, json: async () => ({ runs: [] }) } as Response;
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.innerHTML).toContain('data-slot="review-history-empty"');
    await act(async () => {
      root.unmount();
    });
    container.remove();
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
