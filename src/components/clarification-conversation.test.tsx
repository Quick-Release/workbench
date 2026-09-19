// @vitest-environment happy-dom
import { strictEqual } from "node:assert";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ClarificationConversation } from "./ClarificationConversation";

// The managed conversation surface's contract tests (spec #221, ticket
// #232): fetch and EventSource are stubbed at the network boundary, and the
// assertions are what the Developer sees and what the seam receives — the
// two-turn stream, steer versus queue as explicit acts, the two-step stop,
// typed dialogs, the capability list, and the honest gap divider.

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onmessage: ((event: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {}
}

const envelope = (cursor: number, event: unknown) => ({
  cursor,
  envelope: "clarification-events/v1",
  event,
});

const runSection = (events: unknown[]) => ({
  run: {
    runId: "run_1",
    hostRepo: "example/project",
    issueId: "230",
    requestId: "start-req-1",
    state: "active",
    createdAt: "2026-09-18T10:00:01.000Z",
    updatedAt: "2026-09-18T10:00:09.000Z",
  },
  attempts: [
    {
      attemptId: "attempt_1",
      runId: "run_1",
      hostRepo: "example/project",
      requestId: "start-req-1",
      dispatchIntent: {
        kind: "clarification-start",
        provider: "openai-codex-oauth",
        dataDestination: "https://api.openai.com",
      },
      state: "active",
      createdAt: "2026-09-18T10:00:03.000Z",
      updatedAt: "2026-09-18T10:00:03.000Z",
    },
  ],
  latestCursor: events.length,
  events,
});

const ok = (body: unknown) => async () => ({ status: 200, ok: true, json: async () => body });

describe("the clarification conversation surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  const mount = async (fetchMock: ReturnType<typeof vi.fn>) => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ClarificationConversation issueNumber={230} />);
    });
    return { container, root };
  };

  it("renders nothing when the issue has no clarification run", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/run?issue=")) return { status: 404, ok: false } as Response;
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);
    expect(container.querySelector("[data-slot='clarification-conversation']")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("streams a two-turn conversation with provider and destination visible", async () => {
    const events = [
      envelope(1, { type: "operational", kind: "run.started", data: {}, at: "t" }),
      envelope(2, {
        type: "operational",
        kind: "conversation.prompt",
        data: { attemptId: "attempt_1", requestId: "r1", text: "first question" },
        at: "t",
      }),
      envelope(3, {
        type: "conversation",
        attemptId: "attempt_1",
        session: {
          cursor: 1,
          envelope: "pi-managed/v1",
          event: { type: "message_update", text: "reading the issue…" },
        },
      }),
      envelope(4, {
        type: "conversation",
        attemptId: "attempt_1",
        session: {
          cursor: 2,
          envelope: "pi-managed/v1",
          event: { type: "tool_execution", tool: "read_file" },
        },
      }),
      envelope(5, {
        type: "operational",
        kind: "conversation.prompt",
        data: { attemptId: "attempt_1", requestId: "r2", text: "second question" },
        at: "t",
      }),
      envelope(6, {
        type: "conversation",
        attemptId: "attempt_1",
        session: {
          cursor: 3,
          envelope: "pi-managed/v1",
          event: { type: "message_update", text: "answering from what I read before" },
        },
      }),
    ];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/run?issue=")) return ok(runSection(events))();
      if (url.includes("/conversation")) return ok({ available: true, sessionState: "ready" })();
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);

    const surface = container.querySelector("[data-slot='clarification-conversation']");
    expect(surface).toBeTruthy();
    const stream = container.querySelector("[data-slot='clarification-stream']");
    expect(stream?.textContent).toContain("you · first question");
    expect(stream?.textContent).toContain("reading the issue…");
    expect(stream?.textContent).toContain("tool · read_file");
    expect(stream?.textContent).toContain("you · second question");
    expect(stream?.textContent).toContain("answering from what I read before");
    expect(container.textContent).toContain("provider · openai-codex-oauth");
    expect(container.textContent).toContain("destination · https://api.openai.com");

    // The timeline references the conversation without repeating it: the
    // run's operational frames appear, the conversation's do not.
    const timeline = container.querySelector("[data-slot='clarification-timeline']");
    expect(timeline?.textContent).toContain("run · started");
    expect(timeline?.textContent).not.toContain("first question");

    // One live stream subscription, on the newest attempt.
    strictEqual(FakeEventSource.instances.length, 1);
    strictEqual(
      FakeEventSource.instances[0].url,
      "/api/clarification/runs/run_1/attempts/attempt_1/events",
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps steer and queue explicit while a turn is live, and stop-turn confirms first", async () => {
    const events = [
      envelope(1, {
        type: "operational",
        kind: "conversation.prompt",
        data: { attemptId: "attempt_1", requestId: "r1", text: "first question" },
        at: "t",
      }),
      envelope(2, {
        type: "conversation",
        attemptId: "attempt_1",
        session: { cursor: 1, envelope: "pi-managed/v1", event: { type: "accepted", id: "req_1" } },
      }),
    ];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/run?issue=")) return ok(runSection(events))();
      if (url.includes("/conversation")) return ok({ available: true, sessionState: "ready" })();
      if (url.includes("/commands")) return ok({ sent: true, requestId: "server-sees-it" })();
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);

    // The live turn shows the steering acts, not a second prompt button.
    expect(container.querySelector("button[aria-label='send prompt']")).toBeNull();
    const steer = container.querySelector<HTMLButtonElement>("button[aria-label='steer the turn']");
    const queue = container.querySelector<HTMLButtonElement>(
      "button[aria-label='queue follow-up']",
    );
    const stop = container.querySelector<HTMLButtonElement>("button[aria-label='stop turn']");
    expect(steer).toBeTruthy();
    expect(queue).toBeTruthy();
    expect(stop).toBeTruthy();

    const postCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/commands"));

    // Steering the live turn sends the steer kind with a fresh request id.
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='conversation draft']",
    );
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setNativeValue?.call(textarea, "focus on the acceptance criteria");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      steer?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    strictEqual(postCalls().length, 1);
    const firstCall = postCalls()[0] as [string, RequestInit];
    strictEqual(String(firstCall[0]), "/api/clarification/runs/run_1/attempts/attempt_1/commands");
    strictEqual(firstCall[1].method, "POST");
    const body = JSON.parse(String(firstCall[1].body));
    strictEqual(body.command.kind, "steer");
    strictEqual(body.command.text, "focus on the acceptance criteria");
    expect(typeof body.requestId).toBe("string");

    // Stop-turn is a two-step confirm: the first click only asks.
    const before = postCalls().length;
    await act(async () => {
      stop?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const confirm = container.querySelector<HTMLButtonElement>(
      "button[aria-label='confirm stop turn']",
    );
    expect(confirm).toBeTruthy();
    strictEqual(postCalls().length, before);
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const lastCall = postCalls().at(-1) as unknown as [string, RequestInit];
    const stopBody = JSON.parse(String(lastCall[1].body));
    strictEqual(stopBody.command.kind, "stop-turn");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders typed dialogs as answerable questions and unsupported widgets as a capability list", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/run?issue=")) return ok(runSection([]))();
      if (url.includes("/conversation"))
        return ok({
          available: true,
          sessionState: "waiting-for-input",
          pendingDialogs: [
            {
              dialogId: "dialog_1",
              kind: "select",
              request: { type: "select", options: ["clarify the goal", "list the risks"] },
            },
          ],
          unsupportedCapabilities: [
            { capability: "custom-widget", count: 2, frame: { type: "extension_widget" } },
          ],
        })();
      if (url.includes("/commands")) return ok({ sent: true, requestId: "server-sees-it" })();
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);

    const dialog = container.querySelector("[data-slot='clarification-dialog']");
    expect(dialog?.textContent).toContain("select");
    const option = container.querySelector<HTMLButtonElement>(
      "button[aria-label='answer clarify the goal']",
    );
    expect(option).toBeTruthy();
    await act(async () => {
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const commandCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/commands"));
    expect(commandCall).toBeTruthy();
    const body = JSON.parse(String((commandCall as unknown as [string, RequestInit])[1].body));
    strictEqual(body.command.kind, "answer-dialog");
    strictEqual(body.command.dialogId, "dialog_1");
    strictEqual(body.command.value, "clarify the goal");

    const capabilities = container.querySelector("[data-slot='clarification-capabilities']");
    expect(capabilities?.textContent).toContain("custom-widget ×2");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the explicit gap divider when the viewer's cursor predates retention", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/run?issue="))
        return ok({
          ...runSection([
            envelope(3, {
              type: "conversation",
              attemptId: "attempt_1",
              session: {
                cursor: 1,
                envelope: "pi-managed/v1",
                event: { type: "message_update", text: "kept" },
              },
            }),
          ]),
          gap: { after: 0, firstRetainedCursor: 3 },
        })();
      if (url.includes("/conversation")) return ok({ available: true })();
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);
    const gap = container.querySelector("[data-slot='clarification-gap']");
    expect(gap?.textContent).toContain("gap");
    expect(gap?.textContent).toContain("no longer retained");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
