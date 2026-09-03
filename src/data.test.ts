import { describe, expect, it } from "vite-plus/test";

import { overviewData } from "./data";
import { overviewData as generatedData } from "./data.generated";
import { parseOverviewData, parseTicketRecord } from "./schema";

const expectRejected = (input: unknown, pattern: RegExp) => {
  expect(() => parseOverviewData(input)).toThrow(pattern);
};

const ticket = {
  id: "TKT-001",
  title: "Ready ticket",
  status: "ready",
  statusLabel: "ready-for-agent",
  statusDetail: "",
  group: "Ticket system",
  lane: "Core",
  dependencies: "—",
  summary: "Ticket",
  sourcePath: "docs/plans/ticket-system/tickets/TKT-001.md",
  sourceUrl: "https://github.com/Quick-Release/banquinha",
  kind: "plan-ticket",
  progress: { done: 0, total: 1 },
};

const plan = {
  id: "TICKET-SYSTEM",
  title: "Ticket system",
  status: "in-progress",
  statusLabel: "in-progress",
  statusDetail: "Active implementation",
  stream: "Ticket system",
  ticketCount: 1,
  openTicketCount: 1,
  completeTicketCount: 0,
  summary: "A private ticket worker.",
  sourcePath: "docs/plans/ticket-system/README.md",
  sourceUrl: "https://github.com/Quick-Release/banquinha",
};

const change = {
  id: "add-copilot",
  title: "Add copilot",
  status: "planned",
  statusLabel: "needs-triage",
  summary: "A staff copilot proposal.",
  taskCount: 2,
  completeTaskCount: 0,
  sourcePath: "openspec/changes/add-copilot/proposal.md",
  sourceUrl: "https://github.com/Quick-Release/banquinha",
};

const service = {
  id: "github",
  type: "github",
  label: "GitHub",
  status: "connected",
  itemCount: 3,
  message: "ok",
  sourcePath: "docs",
};

describe("overview data boundary", () => {
  it("decodes the real generated data on import", () => {
    expect(overviewData.meta.projectName).toBeTruthy();
    expect(overviewData.tickets.length).toBe(overviewData.meta.ticketCount);
  });

  it("accepts a ticket with its optional external source present", () => {
    expect(parseTicketRecord({ ...ticket, externalSource: "https://example.com/tkt-001" })).toEqual(
      expect.objectContaining({ externalSource: "https://example.com/tkt-001" }),
    );
  });

  it("rejects an unknown ticket status and names the path", () => {
    expect(() => parseTicketRecord({ ...ticket, status: "done" })).toThrow(/status/);
  });

  it("rejects a ticket with a missing required field and names the path", () => {
    const { title: _omitted, ...incomplete } = ticket;
    expect(() => parseTicketRecord(incomplete)).toThrow(/title/);
  });

  it("rejects a ticket with an unknown record kind", () => {
    expect(() => parseTicketRecord({ ...ticket, kind: "release" })).toThrow(/kind/);
  });

  it("rejects a ticket with non-numeric progress counts", () => {
    expect(() => parseTicketRecord({ ...ticket, progress: { done: "most", total: 1 } })).toThrow(
      /done/,
    );
  });

  it("rejects an unknown theme key and names the path", () => {
    const drifted: unknown = {
      ...generatedData,
      meta: {
        ...generatedData.meta,
        theme: { ...generatedData.meta.theme, "not-a-color": "#000000" },
      },
    };
    expectRejected(drifted, /not-a-color/);
  });

  it("rejects a plan with an unknown status", () => {
    const drifted: unknown = {
      ...generatedData,
      plans: [{ ...plan, status: "done" }],
    };
    expectRejected(drifted, /status/);
  });

  it("rejects a spec change with an unknown status", () => {
    const drifted: unknown = {
      ...generatedData,
      changes: [{ ...change, status: "shipped" }],
    };
    expectRejected(drifted, /status/);
  });

  it("rejects a service with an unknown connection status", () => {
    const drifted: unknown = {
      ...generatedData,
      meta: { ...generatedData.meta, services: [{ ...service, status: "offline" }] },
    };
    expectRejected(drifted, /status/);
  });

  it("rejects a source entry missing its path", () => {
    const drifted: unknown = {
      ...generatedData,
      meta: { ...generatedData.meta, sources: [{ label: "Dashboard" }] },
    };
    expectRejected(drifted, /path/);
  });

  it("accepts the sessions payload on the generated data", () => {
    expect(generatedData.sessions.enabled).toBe(true);
    expect(generatedData.sessions.generatedAt).toBeTruthy();
    expect(Array.isArray(generatedData.sessions.perDay)).toBe(true);
    expect(Array.isArray(generatedData.sessions.perModel)).toBe(true);
    expect(Array.isArray(generatedData.sessions.sessions)).toBe(true);
  });

  it("rejects a session day row with non-numeric token counts", () => {
    const drifted: unknown = {
      ...generatedData,
      sessions: {
        ...generatedData.sessions,
        perDay: [
          {
            day: "2026-09-01",
            provider: "prov",
            model: "GLM-5.3-Flash",
            requests: 1,
            sessions: 1,
            inputTokens: "lots",
            outputTokens: 10,
            cacheTokens: 0,
            modelMs: 100,
          },
        ],
      },
    };
    expectRejected(drifted, /inputTokens/);
  });

  it("rejects a session record with a missing title", () => {
    const drifted: unknown = {
      ...generatedData,
      sessions: {
        ...generatedData.sessions,
        sessions: [
          {
            id: "sess_1",
            taskType: "interactive",
            parent: "",
            directory: "/tmp",
            started: "2026-09-01T10:00:00.000Z",
            requests: 1,
            inputTokens: 10,
            outputTokens: 10,
            modelMs: 100,
            edits: 0,
            writes: 0,
          },
        ],
      },
    };
    expectRejected(drifted, /title/);
  });

  it("rejects a sessions payload with a non-boolean enabled flag", () => {
    const drifted: unknown = {
      ...generatedData,
      sessions: { ...generatedData.sessions, enabled: "yes" },
    };
    expectRejected(drifted, /enabled/);
  });

  it("rejects data missing the sessions key entirely", () => {
    const { sessions: _omitted, ...withoutSessions } = generatedData;
    expectRejected(withoutSessions, /sessions/);
  });
});
