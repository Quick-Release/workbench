// @vitest-environment happy-dom
import { deepStrictEqual, strictEqual } from "node:assert";
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

const runSection = (events: unknown[], overrides: Record<string, unknown> = {}) => ({
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
      origin: "manual",
      createdAt: "2026-09-18T10:00:03.000Z",
      updatedAt: "2026-09-18T10:00:03.000Z",
    },
  ],
  latestCursor: events.length,
  events,
  lease: {
    owner: "workbench-clarification-coordinator",
    generation: 1,
    acquiredAt: "2026-09-18T10:00:05.000Z",
    expiresAt: "2026-09-18T10:00:35.000Z",
    expired: false,
  },
  usage: {
    runId: "run_1",
    lines: [
      {
        lineId: "usage_1",
        kind: "reported",
        unit: "provider",
        value: null,
        detail: { totalTokens: 12400 },
        createdAt: "2026-09-18T10:00:06.000Z",
      },
    ],
    totals: { reported: {}, estimated: {}, unknownLines: 0 },
  },
  escalations: [],
  ...overrides,
});

const ok = (body: unknown) => async () => ({ status: 200, ok: true, json: async () => body });

const draftView = {
  runId: "run_1",
  attemptId: "attempt_1",
  draft: null,
  gaps: ["behavior is a stub"],
  briefCompleteness: "needs-information",
  issue: null,
  diff: null,
  warnings: [],
  savingIsNotApproval: "Saving a draft is not publication approval",
};

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
      // A steer the runtime refused after the intent landed: the stream
      // must show the refusal, never just the ask.
      envelope(7, {
        type: "operational",
        kind: "conversation.steer-refused",
        data: { attemptId: "attempt_1", requestId: "s9", code: "turn_not_in_flight" },
        at: "t",
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
    expect(stream?.textContent).toContain("refused · steer (turn_not_in_flight)");
    expect(container.textContent).toContain("provider · openai-codex-oauth");
    expect(container.textContent).toContain("destination · https://api.openai.com");

    // The timeline references the conversation without repeating it: the
    // run's operational frames appear, the conversation's do not.
    const timeline = container.querySelector("[data-slot='clarification-timeline']");
    expect(timeline?.textContent).toContain("run started");
    // The conversation commands are the chat surface's rows, not the
    // timeline's.
    expect(timeline?.textContent).not.toContain("conversation.prompt");
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

// --- The inspection display (spec #221, ticket #237): panel-per-axis
// --- status, the attempt-segmented timeline, the return card, the
// --- controls-moved notice, and the typed destructive discard.

describe("the inspection display layer", () => {
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

  const withDraft = (fetchMock: (url: string, init?: RequestInit) => Promise<unknown>) => {
    const wrapped = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/draft")) return ok(draftView)();
      return fetchMock(url, init);
    });
    return wrapped;
  };

  it("renders status panel-per-axis in each owner's vocabulary, never one merged word", async () => {
    const fetchMock = withDraft(
      vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.includes("/run?issue="))
          return ok(
            runSection([], {
              run: { ...runSection([]).run, state: "awaiting-human" },
              attempts: [
                {
                  attemptId: "attempt_1",
                  runId: "run_1",
                  hostRepo: "example/project",
                  requestId: "req",
                  dispatchIntent: {},
                  state: "awaiting-human",
                  origin: "manual",
                  createdAt: "t",
                  updatedAt: "t",
                },
              ],
            }),
          )();
        if (url.includes("/conversation")) return ok({ available: false })();
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { container, root } = await mount(fetchMock);

    const panels = container.querySelector("[data-slot='clarification-status-panels']");
    expect(panels).toBeTruthy();
    const axes = [...container.querySelectorAll("[data-slot='clarification-axis']")];
    deepStrictEqual(
      axes.map((axis) => axis.getAttribute("data-axis")),
      ["run", "attempts", "conversation", "readiness", "usage"],
    );
    // Each axis speaks its owner's word: the run axis the lifecycle word,
    // the attempts axis the attempt words, readiness the draft's verdict.
    expect(panels?.textContent).toContain("awaiting-human");
    expect(panels?.textContent).toContain("needs-information");
    expect(panels?.textContent).toContain("reported");
    // The conversation axis renders unknown as the word — amber, never a
    // spinner, never green.
    const conversation = container.querySelector("[data-axis='conversation']");
    expect(conversation?.textContent).toContain("unknown");
    const unknownWord = conversation?.querySelector("[data-unknown='true']");
    expect(unknownWord?.className).toContain("amber");
    strictEqual(container.querySelector(".animate-spin"), null);
    // No merged status word: the old single state badge is gone.
    strictEqual(
      container.querySelector("[data-slot='clarification-conversation'] > .inline-flex"),
      null,
    );
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the return card with checkpoint fields and exactly one primary action", async () => {
    const events = [
      envelope(5, {
        type: "operational",
        kind: "run.halted",
        data: { signature: "sig", repeats: 2 },
        at: "2026-09-18T10:00:09.000Z",
      }),
    ];
    const fetchMock = withDraft(
      vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.includes("/run?issue="))
          return ok(
            runSection(events, {
              run: { ...runSection([]).run, state: "awaiting-human" },
              attempts: [
                {
                  attemptId: "attempt_1",
                  runId: "run_1",
                  hostRepo: "example/project",
                  requestId: "req",
                  dispatchIntent: {},
                  state: "awaiting-human",
                  origin: "manual",
                  createdAt: "t",
                  updatedAt: "t",
                },
              ],
              escalations: [
                {
                  runId: "run_1",
                  attemptId: "attempt_1",
                  signature: "sig",
                  repeats: 2,
                  classification: "known-failure",
                  kind: "provider-failure",
                  reason: "quota",
                  remainingAuthority: ["manual-retry"],
                  decision: "decide whether to start a fresh manual attempt or abandon this run",
                  at: "t",
                },
              ],
            }),
          )();
        if (url.includes("/conversation")) return ok({ available: false })();
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { container, root } = await mount(fetchMock);

    const card = container.querySelector("[data-slot='clarification-return-card']");
    expect(card?.textContent).toContain("awaiting-human");
    // Ownership words: the coordinator holds the controls.
    expect(card?.textContent).toContain("controls held by this install's coordinator");
    expect(card?.textContent).toContain("cursor 5");
    expect(card?.textContent).toContain(
      "decide whether to start a fresh manual attempt or abandon this run",
    );
    // Exactly one primary action — and it is not the destructive discard.
    strictEqual(card?.querySelectorAll("[data-slot='clarification-primary-action']").length, 1);
    const primary = card?.querySelector("[data-slot='clarification-primary-action']");
    expect(primary?.textContent).toContain("Review the record");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("follows live from the return card after a reconnect gap", async () => {
    const fetchMock = withDraft(
      vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.includes("/run?issue="))
          return ok(runSection([], { gap: { after: 0, firstRetainedCursor: 3 } }))();
        if (url.includes("/conversation")) return ok({ available: true, sessionState: "ready" })();
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { container, root } = await mount(fetchMock);
    const card = container.querySelector("[data-slot='clarification-return-card']");
    expect(card?.textContent).toContain("Follow live");
    const primary = container.querySelector<HTMLButtonElement>(
      "[data-slot='clarification-primary-action']",
    );
    await act(async () => {
      primary?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // Following live dismisses the card — the timeline below is the follow.
    strictEqual(container.querySelector("[data-slot='clarification-return-card']"), null);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("notifies that controls moved when a command is fenced by another holder", async () => {
    const fetchMock = withDraft(
      vi.fn(async (url: string) => {
        if (url.includes("/run?issue=")) return ok(runSection([]))();
        if (url.includes("/conversation")) return ok({ available: true, sessionState: "ready" })();
        if (url.includes("/commands"))
          return {
            status: 409,
            ok: false,
            json: async () => ({ error: "busy", message: "held elsewhere" }),
          };
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { container, root } = await mount(fetchMock);
    strictEqual(
      container.querySelector("[data-slot='clarification-controls-moved']"),
      null,
      "no notice before any fenced action",
    );
    const send = container.querySelector<HTMLButtonElement>("button[aria-label='send prompt']");
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='conversation draft']",
    );
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setNativeValue?.call(textarea, "a fenced prompt");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      send?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const notice = container.querySelector("[data-slot='clarification-controls-moved']");
    expect(notice?.textContent).toContain("controls moved");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("gates the discard behind a typed confirmation that echoes the run id", async () => {
    const fetchMock = withDraft(
      vi.fn(async (url: string) => {
        if (url.includes("/run?issue="))
          return ok(runSection([], { run: { ...runSection([]).run, state: "awaiting-human" } }))();
        if (url.includes("/conversation")) return ok({ available: false })();
        if (url.includes("/discard"))
          return ok({
            runId: "run_1",
            hostRepo: "example/project",
            issueId: "230",
            requestId: "req",
            state: "terminal",
            createdAt: "t",
            updatedAt: "t",
            discardedAt: "t",
          })();
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { container, root } = await mount(fetchMock);

    const region = container.querySelector("[data-slot='clarification-discard']");
    expect(region?.textContent).toContain("unrecoverable");
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='type the run id to confirm discarding retained evidence']",
    );
    const confirm = container.querySelector<HTMLButtonElement>(
      "button[aria-label='discard retained evidence']",
    );
    expect(confirm).toBeTruthy();
    // A wrong typing keeps the destructive button disabled.
    strictEqual(confirm?.disabled, true);
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setNativeValue?.call(input, "run_9");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    strictEqual(confirm?.disabled, true);
    // The exact echo arms it, and the click sends the confirmation.
    await act(async () => {
      setNativeValue?.call(input, "run_1");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    strictEqual(confirm?.disabled, false);
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const discardCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/discard"));
    expect(discardCall).toBeTruthy();
    const [url, init] = discardCall as unknown as [string, RequestInit];
    expect(url).toContain("/api/clarification/runs/run_1/discard");
    strictEqual(init.method, "POST");
    deepStrictEqual(JSON.parse(String(init.body)), { confirmation: "run_1" });
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders no discard control on a run with nothing discardable", async () => {
    const fetchMock = withDraft(
      vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.includes("/run?issue=")) return ok(runSection([]))();
        if (url.includes("/conversation")) return ok({ available: true, sessionState: "ready" })();
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { container, root } = await mount(fetchMock);
    strictEqual(container.querySelector("[data-slot='clarification-discard']"), null);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the timeline segmented by attempt with raw detail behind expands", async () => {
    const events = [
      envelope(1, {
        type: "operational",
        kind: "run.started",
        data: { issueId: "230", requestId: "start-req-1" },
        at: "2026-09-18T10:00:01.000Z",
      }),
      envelope(2, {
        type: "operational",
        kind: "attempt.recorded",
        data: { attemptId: "attempt_1", issueNumber: 230 },
        at: "t",
      }),
      envelope(3, {
        type: "conversation",
        attemptId: "attempt_1",
        session: {
          cursor: 1,
          envelope: "pi-managed/v1",
          event: { type: "message_update", text: "a streamed answer" },
        },
      }),
      envelope(4, {
        type: "operational",
        kind: "attempt.coordinator-retried",
        data: { fromAttemptId: "attempt_1", attemptId: "attempt_2" },
        at: "t",
      }),
      envelope(5, {
        type: "operational",
        kind: "attempt.outcome",
        data: {
          attemptId: "attempt_2",
          kind: "provider-failure",
          classification: "known-failure",
          nextAction: "await-human",
          reason: "quota",
        },
        at: "t",
      }),
    ];
    const secondAttempt = {
      attemptId: "attempt_2",
      runId: "run_1",
      hostRepo: "example/project",
      requestId: "req-2",
      dispatchIntent: {},
      state: "awaiting-human",
      origin: "coordinator-retry",
      createdAt: "t2",
      updatedAt: "t2",
    };
    const fetchMock = withDraft(
      vi.fn(async (url: string, _init?: RequestInit) => {
        if (url.includes("/run?issue="))
          return ok(
            runSection(events, { attempts: [runSection([]).attempts[0], secondAttempt] }),
          )();
        if (url.includes("/conversation")) return ok({ available: false })();
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { container, root } = await mount(fetchMock);

    const timeline = container.querySelector("[data-slot='clarification-timeline']");
    expect(timeline).toBeTruthy();
    const segments = [...(timeline?.querySelectorAll("[data-slot='clarification-segment']") ?? [])];
    deepStrictEqual(
      segments.map((segment) => segment.getAttribute("data-segment")),
      ["run", "attempt_1", "attempt_2"],
    );
    const text = timeline?.textContent ?? "";
    // Plain-language entries.
    expect(text).toContain("run started for issue 230");
    expect(text).toContain("quota");
    // The retry reads as its own named segment.
    expect(text).toContain("attempt 2 — the coordinator's evidence-gated retry");
    // The conversation is referenced once, never duplicated.
    strictEqual((text.match(/the conversation streamed on this attempt/g) ?? []).length, 1);
    expect(text).not.toContain("a streamed answer");
    // Raw detail sits behind an expand.
    const expand = timeline?.querySelector("details");
    expect(expand?.querySelector("summary")?.textContent).toContain("run started");
    expect(expand?.textContent).toContain("start-req-1");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
