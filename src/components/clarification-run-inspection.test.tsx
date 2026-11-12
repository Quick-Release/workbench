// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { rememberOwnRequest } from "../lib/clarification-viewer";
import { ClarificationRunSection } from "./ClarificationRunInspection";

// The run section's render tests (spec #221, ticket #237): fetch and
// EventSource stubbed at the network boundary; assertions are what the
// Developer sees and what the seam receives — panel-per-axis status, the
// return card with one primary action, fresh approval through the
// manifest, two-step and typed confirmations, detach versus reconnect,
// the controls-moved notice, and unknown as the word.

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onmessage: ((event: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const REVISION = { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" };

const envelope = (cursor: number, event: unknown) => ({
  cursor,
  envelope: "clarification-events/v1",
  event,
});

const op = (cursor: number, kind: string, data: Record<string, unknown>) =>
  envelope(cursor, { type: "operational", kind, data, at: "2026-09-18T10:00:05.000Z" });

const runRow = (state: string) => ({
  runId: "run_1",
  hostRepo: "example/project",
  issueId: "230",
  requestId: "start-1",
  state,
  createdAt: "2026-09-18T10:00:00.000Z",
  updatedAt: "2026-09-18T10:00:05.000Z",
});

const attemptRow = (state: string) => ({
  attemptId: "attempt_1",
  runId: "run_1",
  hostRepo: "example/project",
  requestId: "start-1",
  dispatchIntent: { provider: "openai-codex-oauth", dataDestination: "https://api.openai.com" },
  state,
  origin: "manual",
  createdAt: "2026-09-18T10:00:01.000Z",
  updatedAt: "2026-09-18T10:00:05.000Z",
});

const deniedSection = {
  run: runRow("awaiting-human"),
  attempts: [attemptRow("terminal")],
  latestCursor: 3,
  events: [
    op(1, "run.started", { issueId: "230", requestId: "start-1" }),
    op(2, "attempt.recorded", { attemptId: "attempt_1" }),
    op(3, "attempt.start-denied", { attemptId: "attempt_1", code: "runtime_unconfigured" }),
  ],
};

const inspectionView = (lease: unknown = null) => ({
  runId: "run_1",
  lease,
  usage: { lines: [], totals: { reported: {}, estimated: {}, unknownLines: 0 } },
  escalations: [],
  readiness: {
    axes: [
      { axis: "tracker-eligibility", verdict: "ready", reasons: [] },
      { axis: "brief-completeness", verdict: "needs-information", reasons: ["no draft"] },
      { axis: "host-capability", verdict: "ready", reasons: [] },
      { axis: "research-sufficiency", verdict: "needs-information", reasons: [] },
      { axis: "authorization", verdict: "ready", reasons: [] },
    ],
  },
});

const manifest = {
  issue: { number: 230, title: "Clarification", revision: REVISION },
  provider: "openai-codex-oauth",
  dataDestination: "https://api.openai.com",
  capabilitySummary: ["reads the pinned issue"],
  egressStatement: "egress statement",
  budgetLine: "budget line",
  noPublishingLine: "Publishing is NOT granted by this approval",
};

const ok = (body: unknown) => ({ status: 200, ok: true, json: async () => body }) as Response;

const routes =
  (section: unknown, inspection: unknown = inspectionView()) =>
  async (url: string, init?: RequestInit) => {
    if (url.includes("/run?issue=")) return ok(section);
    if (url.includes("/inspection")) return ok(inspection);
    if (url.includes("/conversation")) return ok({ available: false });
    if (url.includes("/manifest")) return ok(manifest);
    if (url.includes("/actions")) {
      const body = JSON.parse(String(init?.body));
      return ok({
        kind: body.action.kind,
        done: true,
        requestId: body.requestId,
        run: runRow("awaiting-human"),
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const type = async (input: HTMLInputElement | null, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("the clarification run section", () => {
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
      root.render(<ClarificationRunSection issueNumber={230} issueLabel="GH-230" />);
    });
    await act(async () => {});
    const unmount = async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    };
    return { container, unmount };
  };

  const actionCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/actions"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  it("renders one panel per axis in its owner's words", async () => {
    const fetchMock = vi.fn(routes(deniedSection));
    const { container, unmount } = await mount(fetchMock);
    const axes = [...container.querySelectorAll("[data-slot='clarification-status-axis']")].map(
      (node) => node.getAttribute("data-axis"),
    );
    expect(axes).toEqual(["lifecycle", "attempts", "conversation", "readiness", "usage"]);
    const lifecycle = container.querySelector("[data-axis='lifecycle']");
    expect(lifecycle?.textContent).toContain("awaiting-human");
    // The denied attempt is closed: no conversation is live to name.
    const conversation = container.querySelector("[data-axis='conversation']");
    expect(conversation?.textContent).toContain("none live");
    expect(container.innerHTML).not.toMatch(/animate-spin|green/);
    await unmount();
  });

  it("segments the timeline by attempt and keeps raw detail behind an expand", async () => {
    const fetchMock = vi.fn(routes(deniedSection));
    const { container, unmount } = await mount(fetchMock);
    const headings = [...container.querySelectorAll("[data-slot='timeline-segment'] > p")].map(
      (node) => node.textContent,
    );
    expect(headings[0]).toBe("run");
    expect(headings[1]).toContain("attempt 1");
    const denied = [...container.querySelectorAll("[data-slot='timeline-entry']")].find((node) =>
      node.textContent?.includes("denied before it could start"),
    );
    expect(denied?.tagName).toBe("DETAILS");
    expect(denied?.querySelector("pre")?.textContent).toContain("attempt.start-denied");
    await unmount();
  });

  it("returns with the checkpoint fields and one primary action that re-renders the manifest", async () => {
    const fetchMock = vi.fn(routes(deniedSection));
    const { container, unmount } = await mount(fetchMock);
    const card = container.querySelector("[data-slot='clarification-return-card']");
    expect(card?.getAttribute("data-reason")).toBe("awaiting-human");
    for (const field of [
      "State",
      "Ownership",
      "Last trusted event",
      "Changed files",
      "Checks",
      "Missing decision",
    ])
      expect(card?.textContent).toContain(field);
    expect(card?.querySelectorAll("button").length).toBe(1);

    // Retry is a fresh approval: the manifest renders first, ending with
    // the no-publishing line, and nothing is sent until its one button.
    await click(container.querySelector("[data-slot='clarification-return-primary']"));
    await act(async () => {});
    const shown = container.querySelector("[data-slot='clarification-manifest']");
    expect(shown?.textContent).toContain("Publishing is NOT granted by this approval");
    expect(actionCalls(fetchMock)).toEqual([]);
    const start = [...(shown?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Start fresh attempt",
    );
    await click(start ?? null);
    const [retry] = actionCalls(fetchMock);
    expect(retry.action).toEqual({ kind: "retry", revision: REVISION });
    expect(typeof retry.requestId).toBe("string");
    await unmount();
  });

  it("asks twice before retaining evidence", async () => {
    const fetchMock = vi.fn(routes(deniedSection));
    const { container, unmount } = await mount(fetchMock);
    await click(container.querySelector("button[aria-label='Retain evidence']"));
    expect(actionCalls(fetchMock)).toEqual([]);
    await click(container.querySelector("button[aria-label='confirm retain evidence']"));
    expect(actionCalls(fetchMock).map((call) => call.action)).toEqual([
      { kind: "retain-evidence" },
    ]);
    await unmount();
  });

  it("discards only after the run id is typed exactly", async () => {
    const fetchMock = vi.fn(routes(deniedSection));
    const { container, unmount } = await mount(fetchMock);
    await click(container.querySelector("button[aria-label='Discard evidence']"));
    const confirm = () =>
      container.querySelector<HTMLButtonElement>("button[aria-label='confirm discard evidence']");
    expect(confirm()?.disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>(
      "input[aria-label='type the run id to discard']",
    );
    await type(input, "run_");
    expect(confirm()?.disabled).toBe(true);
    await type(input, "run_1");
    expect(confirm()?.disabled).toBe(false);
    await click(confirm());
    expect(actionCalls(fetchMock).map((call) => call.action)).toEqual([
      { kind: "discard-evidence", confirmation: "run_1" },
    ]);
    // Discard is the only destructive button in the matrix.
    const destructive = container.querySelectorAll(
      "[data-slot='clarification-action'] button[data-variant='destructive']",
    );
    expect(
      [...destructive].map((node) => node.closest("[data-action]")?.getAttribute("data-action")),
    ).toEqual(["discard-evidence"]);
    await unmount();
  });

  it("detaches without cancelling and reconnects to the same stream", async () => {
    const live = {
      run: runRow("active"),
      attempts: [attemptRow("active")],
      latestCursor: 1,
      events: [op(1, "run.started", { issueId: "230", requestId: "start-1" })],
    };
    const fetchMock = vi.fn(routes(live));
    const { container, unmount } = await mount(fetchMock);
    expect(FakeEventSource.instances.length).toBe(1);
    // The managed session is not live on this install: its word is
    // unknown, amber, never a spinner.
    const conversation = container.querySelector("[data-axis='conversation']");
    expect(conversation?.querySelector("[data-tone='unknown']")?.textContent).toBe("unknown");
    expect(container.innerHTML).not.toMatch(/animate-spin|green/);
    await click(container.querySelector("button[aria-label='Detach']"));
    expect(FakeEventSource.instances[0].closed).toBe(true);
    // Detaching sent nothing to the seam: no command, no action.
    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method),
    ).toEqual([]);
    await click(container.querySelector("button[aria-label='Reconnect']"));
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1].closed).toBe(false);
    await unmount();
  });

  it("shows the controls-moved notice when another viewer acted after this tab", async () => {
    rememberOwnRequest("mine-1");
    const moved = {
      run: runRow("active"),
      attempts: [attemptRow("active")],
      latestCursor: 2,
      events: [
        op(1, "conversation.prompt", { attemptId: "attempt_1", requestId: "mine-1", text: "a" }),
        op(2, "conversation.prompt", { attemptId: "attempt_1", requestId: "theirs-1", text: "b" }),
      ],
    };
    const lease = {
      owner: "workbench-clarification-coordinator",
      generation: 1,
      acquiredAt: "2026-09-18T10:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      expired: false,
    };
    const fetchMock = vi.fn(routes(moved, inspectionView(lease)));
    const { container, unmount } = await mount(fetchMock);
    const notice = container.querySelector("[data-slot='clarification-controls-moved']");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("controls moved to another viewer");
    await unmount();
  });

  it("starts only through the rendered manifest when the issue has no run", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/run?issue=")) return { status: 404, ok: false } as Response;
      if (url.includes("/manifest")) return ok(manifest);
      if (url.includes("/start"))
        return ok({
          started: true,
          run: { runId: "run_1", issueId: "230", state: "active", createdAt: "t", updatedAt: "t" },
          attempt: { attemptId: "attempt_1", state: "active", createdAt: "t", updatedAt: "t" },
        });
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, unmount } = await mount(fetchMock);
    expect(container.querySelector("[data-slot='clarification-run-inspection']")).toBeNull();
    await click(container.querySelector("button[aria-label='Clarify GH-230']"));
    await act(async () => {});
    expect(container.textContent).toContain("Publishing is NOT granted by this approval");
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Start",
    );
    await click(start ?? null);
    const startCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/start"));
    const body = JSON.parse(String((startCall as unknown as [string, RequestInit])[1].body));
    expect(body.issue).toBe(230);
    expect(body.revision).toEqual(REVISION);
    await unmount();
  });
});
