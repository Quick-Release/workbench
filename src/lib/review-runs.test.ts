import { vi } from "vite-plus/test";

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, expect, it } from "vite-plus/test";

import { ReviewRunHttpError, cancelReviewRun, streamReviewRun } from "./review-runs";

// The review-run client (ticket #26): the SSE frame parser and the two
// POSTs, with the network boundary stubbed — only engine + pr ever travel,
// and a server rejection surfaces as a typed error, never as success.

const sseResponse = (frames: unknown[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );

describe("streamReviewRun", () => {
  it("parses each SSE frame into a typed run event", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        { type: "started", engine: "coderabbit", pr: 42 },
        { type: "output", stream: "stdout", text: "finding one\n" },
        { type: "exit", code: 0, signal: null, cancelled: false },
      ]),
    ) as unknown as typeof fetch;

    const events = [];
    for await (const event of streamReviewRun({ engine: "coderabbit", pr: 42, fetchImpl })) {
      events.push(event);
    }

    deepStrictEqual(events, [
      { type: "started", engine: "coderabbit", pr: 42 },
      { type: "output", stream: "stdout", text: "finding one\n" },
      { type: "exit", code: 0, signal: null, cancelled: false },
    ]);
    const [url, init] = fetchMockCalls(fetchImpl)[0] as [string, RequestInit];
    strictEqual(url, "/api/review");
    strictEqual(init.method, "POST");
  });

  it("throws a typed error carrying the server's payload when the start is rejected", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: "run_busy",
        message: "a coderabbit review is already running; cancel it or wait for it to finish",
      }),
    })) as unknown as typeof fetch;

    await expect(async () => {
      for await (const _event of streamReviewRun({
        engine: "coderabbit",
        pr: 42,
        fetchImpl,
      })) {
        // no events expected
      }
    }).rejects.toMatchObject({ status: 409, payload: { error: "run_busy" } });
  });
});

describe("cancelReviewRun", () => {
  it("POSTs only the engine to the cancel endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    await cancelReviewRun(fetchImpl as unknown as typeof fetch)("zcode");
    const [url, init] = fetchMockCalls(fetchImpl)[0];
    strictEqual(url, "/api/review/cancel");
    strictEqual(init?.method, "POST");
    deepStrictEqual(JSON.parse(String(init?.body)), { engine: "zcode" });
  });

  it("throws a typed error when the server refuses the cancel", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "no_run", message: "no active zcode review" }),
    })) as unknown as typeof fetch;

    await expect(
      cancelReviewRun(fetchImpl as unknown as typeof fetch)("zcode"),
    ).rejects.toMatchObject({ status: 404, payload: { error: "no_run" } });
  });
});

// vi.fn records calls on the mock itself; this helper keeps the tests honest
// about what the boundary saw.
function fetchMockCalls(fetchImpl: unknown): [string, RequestInit][] {
  return (fetchImpl as { mock: { calls: [string, RequestInit][] } }).mock.calls;
}

describe("the issue-agent client (issue #40)", () => {
  it("sends the issue and model, never a command, on an agent run", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([{ type: "exit", code: 0, signal: null, cancelled: false }]),
    ) as unknown as typeof fetch;
    for await (const _event of streamReviewRun({
      engine: "opencode",
      issue: 40,
      model: "ollama/qwen3-coder:30b",
      fetchImpl,
    })) {
      // drain
    }
    const [, init] = fetchMockCalls(fetchImpl)[0] as [string, RequestInit];
    deepStrictEqual(JSON.parse(String(init.body)), {
      engine: "opencode",
      issue: 40,
      model: "ollama/qwen3-coder:30b",
    });
  });
});

describe("ReviewRunHttpError denials (GH-136)", () => {
  it("renders the bug gate's denial with its blocking references", () => {
    const error = new ReviewRunHttpError(403, {
      error: "client_bugs_open",
      message: "1 open client bug — new feature starts are paused until it closes.",
      blocking: [
        {
          id: "GH-12",
          title: "Checkout charges twice",
          url: "https://github.com/example/project/issues/12",
        },
      ],
    });
    const rendered = error.denialMessage();
    expect(rendered).toContain("GH-12");
    expect(rendered).toContain("Checkout charges twice");
    expect(rendered).toContain("paused");
  });

  it("a non-denial rejection carries no denial message", () => {
    expect(
      new ReviewRunHttpError(409, {
        error: "run_busy",
        message: "a coderabbit review is already running",
      }).denialMessage(),
    ).toBeNull();
    expect(new ReviewRunHttpError(500, null).denialMessage()).toBeNull();
  });
});
