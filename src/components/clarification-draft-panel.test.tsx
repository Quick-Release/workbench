// @vitest-environment happy-dom
import { strictEqual } from "node:assert";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ClarificationDraftPanel } from "./ClarificationDraftPanel";
import { clarificationDraftVersion } from "../types";

// The Clarification draft surface's contract tests (spec #221, ticket
// #233): fetch is stubbed at the network boundary, and the assertions are
// what the Developer sees and what the seam receives — the served draft
// with its gaps and provenance kinds, saving as a PUT of the composed
// document that never looks like approval, and the visible issue-body diff
// rendered line by line.

const runSection = {
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
      dispatchIntent: { kind: "clarification-start" },
      state: "active",
      createdAt: "2026-09-18T10:00:03.000Z",
      updatedAt: "2026-09-18T10:00:03.000Z",
    },
  ],
  latestCursor: 0,
  events: [],
};

const draftDocument = {
  version: clarificationDraftVersion,
  profile: "bug",
  behavior: "the sync command exits 0 on a clean tree",
  observation: "it exits 1 with a lockfile warning",
  reproduction: "run pnpm sync on a clean checkout",
  boundary: "",
  scope: "scripts/sync only",
  exclusions: ["the pack-smoke harness"],
  acceptance: ["sync exits 0 on a clean tree"],
  dependencies: "",
  performanceClaim: "",
  performanceEvidence: "",
  assumptions: [
    {
      label: "lockfile",
      text: "lockfile v9 stays",
      material: false,
      provenance: { kind: "model", source: "conversation", locator: "attempt_1 turn 3" },
    },
  ],
  evidence: [
    {
      claim: "sync reads the lockfile",
      provenance: { kind: "tracker", source: "issue", locator: "#230 body" },
    },
  ],
};

const draftView = {
  runId: "run_1",
  attemptId: "attempt_1",
  draft: draftDocument,
  gaps: [],
  briefCompleteness: "ready",
  issue: {
    number: 230,
    revision: { updatedAt: "2026-09-18T10:00:00.000Z", bodyHash: "sha-256:abc" },
    body: "old body",
  },
  diff: {
    unchanged: false,
    added: 12,
    removed: 1,
    lines: [
      { kind: "removed", text: "old body" },
      { kind: "added", text: "## Behavior" },
      { kind: "added", text: "" },
      { kind: "added", text: "the sync command exits 0 on a clean tree" },
    ],
  },
  warnings: [],
  savingIsNotApproval: "Saving a draft is not publication approval",
  savedAt: "2026-09-18T10:00:09.000Z",
};

const ok = (body: unknown) => async () => ({ status: 200, ok: true, json: async () => body });

describe("the clarification draft surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mount = async (fetchMock: ReturnType<typeof vi.fn>) => {
    vi.stubGlobal("fetch", fetchMock);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ClarificationDraftPanel issueNumber={230} />);
    });
    return { container, root };
  };

  it("renders nothing when the issue has no clarification run", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/run?issue=")) return { status: 404, ok: false } as Response;
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);
    expect(container.querySelector("[data-slot='clarification-draft']")).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the served draft with its gaps, its provenance kinds, and the saving line", async () => {
    const gapped = {
      ...draftView,
      draft: { ...draftDocument, profile: "unknown" },
      gaps: [
        "the task profile is unclassified — the Developer classifies it; it is never silently a feature",
      ],
      briefCompleteness: "needs-information",
      diff: null,
      issue: null,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/run?issue=")) return ok(runSection)();
      if (String(url).endsWith("/draft")) return ok(gapped)();
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);

    const surface = container.querySelector("[data-slot='clarification-draft']");
    expect(surface).toBeTruthy();
    const behavior = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='draft behavior']",
    );
    expect(behavior?.value).toBe("the sync command exits 0 on a clean tree");

    // The gaps render as the needs-information list they are.
    const gaps = container.querySelector("[data-slot='clarification-draft-gaps']");
    expect(gaps?.textContent).toContain("needs-information");
    expect(gaps?.textContent).toContain("unclassified");

    // Every claim shows its provenance kind — and model is never mistaken
    // for the Developer's own word.
    const provenance = container.querySelector<HTMLSelectElement>(
      "select[aria-label='evidence 1 provenance kind']",
    );
    expect(provenance?.value).toBe("tracker");

    // Saving never looks like approval, before or after any save.
    expect(container.textContent).toContain("Saving a draft is not publication approval");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("saving PUTs the composed document and renders the returned answer", async () => {
    const putCalls: Array<[string, RequestInit]> = [];
    const savedView = { ...draftView, savedAt: "2026-09-18T11:00:00.000Z" };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/run?issue=")) return ok(runSection)();
      if (target.endsWith("/draft") && init?.method === "PUT") {
        putCalls.push([target, init]);
        return ok(savedView)();
      }
      if (target.endsWith("/draft")) return ok(draftView)();
      throw new Error(`unexpected fetch ${target}`);
    });
    const { container, root } = await mount(fetchMock);

    const behavior = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='draft behavior']",
    );
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setNativeValue?.call(behavior, "sync exits 0 and prints nothing");
      behavior?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Two exclusions composed one per line.
    const exclusions = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='draft exclusions']",
    );
    await act(async () => {
      setNativeValue?.call(exclusions, "the pack-smoke harness\nthe tracker sync");
      exclusions?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("button[aria-label='save draft']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    strictEqual(putCalls.length, 1);
    const [url, request] = putCalls[0];
    strictEqual(url, "/api/clarification/runs/run_1/attempts/attempt_1/draft");
    strictEqual(request.method, "PUT");
    const body = JSON.parse(String(request.body));
    strictEqual(body.version, clarificationDraftVersion);
    strictEqual(body.profile, "bug");
    strictEqual(body.behavior, "sync exits 0 and prints nothing");
    deepEqualish(body.exclusions, ["the pack-smoke harness", "the tracker sync"]);

    // The answer's view is what renders: the fresh saved-at stamp.
    expect(container.textContent).toContain("11:00:00");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("the visible diff renders exactly the lines publication would write", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/run?issue=")) return ok(runSection)();
      if (String(url).endsWith("/draft")) return ok(draftView)();
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);

    const diff = container.querySelector("[data-slot='clarification-draft-diff']");
    expect(diff).toBeTruthy();
    const lines = diff?.querySelectorAll("[data-diff-kind]");
    strictEqual(lines?.length, 4);
    strictEqual(lines?.[0].getAttribute("data-diff-kind"), "removed");
    expect(lines?.[0].textContent).toContain("old body");
    strictEqual(lines?.[1].getAttribute("data-diff-kind"), "added");
    expect(lines?.[1].textContent).toContain("## Behavior");
    expect(diff?.textContent).toContain("+12");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("names the warning when the diff base cannot be read", async () => {
    const warned = {
      ...draftView,
      issue: null,
      diff: null,
      warnings: ["the tracker read failed (HTTP 502); the visible issue-body diff withholds"],
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/run?issue=")) return ok(runSection)();
      if (String(url).endsWith("/draft")) return ok(warned)();
      throw new Error(`unexpected fetch ${url}`);
    });
    const { container, root } = await mount(fetchMock);
    expect(container.querySelector("[data-slot='clarification-draft-diff']")).toBeNull();
    const warnings = container.querySelector("[data-slot='clarification-draft-warnings']");
    expect(warnings?.textContent).toContain("withholds");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("follows the newest attempt when a retry supersedes its predecessors", async () => {
    const twoAttempts = {
      ...runSection,
      attempts: [
        {
          ...runSection.attempts[0],
          attemptId: "attempt_1",
          state: "unknown",
        },
        {
          ...runSection.attempts[0],
          attemptId: "attempt_2",
          state: "active",
        },
      ],
    };
    const retried = {
      ...draftView,
      attemptId: "attempt_2",
      draft: { ...draftDocument, behavior: "the retry attempt's draft" },
    };
    const fetchMock = vi.fn(async (url: string) => {
      const target = String(url);
      if (target.includes("/run?issue=")) return ok(twoAttempts)();
      if (target.includes("/attempts/attempt_2/draft")) return ok(retried)();
      if (target.includes("/attempts/attempt_1/draft"))
        throw new Error("the superseded attempt must not be read");
      throw new Error(`unexpected fetch ${target}`);
    });
    const { container, root } = await mount(fetchMock);

    const behavior = container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='draft behavior']",
    );
    expect(behavior?.value).toBe("the retry attempt's draft");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

const deepEqualish = (actual: unknown, expected: unknown) => {
  expect(actual).toEqual(expected);
};
