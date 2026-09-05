import { describe, expect, it } from "vite-plus/test";

import { overviewData } from "./data";
import { overviewData as generatedData } from "./data.generated";
import {
  parseBlockerEdgeRecord,
  parseOverviewData,
  parseTicketRecord,
  parseTrackerMapRecord,
  parseWorkItemRecord,
} from "./schema";

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

  it("rejects a ticket carrying the retired dependencies display string", () => {
    expect(() => parseTicketRecord({ ...ticket, dependencies: "BQ-001" })).toThrow(/dependencies/);
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
    // enabled reflects the host's config (sync on a machine without the
    // session database writes the disabled payload), so assert shape, not
    // this machine's setting.
    expect(typeof generatedData.sessions.enabled).toBe("boolean");
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

  it("rejects data missing the tracker work items key entirely", () => {
    const { workItems: _omitted, ...withoutWorkItems } = generatedData;
    expectRejected(withoutWorkItems, /workItems/);
  });

  it("rejects data missing the blocker edges key entirely", () => {
    const { blockerEdges: _omitted, ...withoutBlockerEdges } = generatedData;
    expectRejected(withoutBlockerEdges, /blockerEdges/);
  });

  it("carries tracker work items and maps from the generated snapshot", () => {
    expect(Array.isArray(generatedData.workItems)).toBe(true);
    expect(Array.isArray(generatedData.maps)).toBe(true);
    for (const record of generatedData.workItems) expect(parseWorkItemRecord(record)).toBeTruthy();
    for (const record of generatedData.maps) expect(parseTrackerMapRecord(record)).toBeTruthy();
  });

  it("carries blocker edges from the generated snapshot", () => {
    expect(Array.isArray(generatedData.blockerEdges)).toBe(true);
    for (const record of generatedData.blockerEdges)
      expect(parseBlockerEdgeRecord(record)).toBeTruthy();
  });
});

describe("tracker work item boundary", () => {
  const workItem = {
    id: "GH-54",
    title: "Skills-ecosystem dashboard: build spec",
    url: "https://github.com/Quick-Release/workbench/issues/54",
    state: "open",
    assignees: ["vvaz"],
    phase: "ticketed",
    triageState: "ready-for-agent",
    deferred: false,
    category: "enhancement",
    kind: null,
    summary: "Collapses the map and ADRs into one buildable spec.",
  };

  it("accepts a fully labeled work item", () => {
    expect(parseWorkItemRecord(workItem)).toEqual(workItem);
  });

  it("accepts a pre-flow work item with nullable fields absent", () => {
    expect(
      parseWorkItemRecord({
        ...workItem,
        assignees: [],
        phase: null,
        triageState: "unlabeled",
        category: null,
        kind: null,
      }),
    ).toEqual(expect.objectContaining({ triageState: "unlabeled", phase: null }));
  });

  it("rejects an excess property on a work item", () => {
    expect(() => parseWorkItemRecord({ ...workItem, dependencies: "—" })).toThrow(/dependencies/);
  });

  it("rejects an unknown workflow phase", () => {
    expect(() => parseWorkItemRecord({ ...workItem, phase: "done" })).toThrow(/phase/);
  });

  it("rejects an unknown triage state", () => {
    expect(() => parseWorkItemRecord({ ...workItem, triageState: "ready" })).toThrow(/triageState/);
  });

  it("rejects an unknown wayfinder kind", () => {
    expect(() => parseWorkItemRecord({ ...workItem, kind: "epic" })).toThrow(/kind/);
  });

  it("rejects an unknown open/closed state", () => {
    expect(() => parseWorkItemRecord({ ...workItem, state: "merged" })).toThrow(/state/);
  });

  it("rejects a work item missing its summary", () => {
    const { summary: _omitted, ...incomplete } = workItem;
    expect(() => parseWorkItemRecord(incomplete)).toThrow(/summary/);
  });
});

describe("tracker map boundary", () => {
  const trackerMap = {
    mapId: "GH-41",
    title: "Skills-ecosystem dashboard",
    url: "https://github.com/Quick-Release/workbench/issues/41",
    ticketIds: ["GH-42", "GH-55"],
  };

  it("accepts a map record with member ids in map order", () => {
    expect(parseTrackerMapRecord(trackerMap)).toEqual(trackerMap);
  });

  it("rejects a map record with an excess property", () => {
    expect(() => parseTrackerMapRecord({ ...trackerMap, blockedBy: [] })).toThrow(/blockedBy/);
  });

  it("rejects a map record missing its member ids", () => {
    const { ticketIds: _omitted, ...incomplete } = trackerMap;
    expect(() => parseTrackerMapRecord(incomplete)).toThrow(/ticketIds/);
  });

  it("rejects a map record with non-string member ids", () => {
    expect(() => parseTrackerMapRecord({ ...trackerMap, ticketIds: [42] })).toThrow(/ticketIds/);
  });
});

describe("blocker edge boundary", () => {
  const edge = {
    blockedId: "GH-56",
    blockerId: "GH-55",
    source: "github-native",
    sourceRef: "https://github.com/Quick-Release/workbench/issues/56",
  };

  it("accepts a native edge with its provenance", () => {
    expect(parseBlockerEdgeRecord(edge)).toEqual(edge);
  });

  it("accepts a line edge over a cross-source reference", () => {
    const lineEdge = {
      blockedId: "BQ-12",
      blockerId: "GH-47",
      source: "blocked-by-line",
      sourceRef: "docs/plans/dashboard/tickets/BQ-12.md",
    };
    expect(parseBlockerEdgeRecord(lineEdge)).toEqual(lineEdge);
  });

  it("rejects an unknown edge source", () => {
    expect(() => parseBlockerEdgeRecord({ ...edge, source: "notion" })).toThrow(/source/);
  });

  it("rejects an edge missing its blocker id", () => {
    const { blockerId: _omitted, ...incomplete } = edge;
    expect(() => parseBlockerEdgeRecord(incomplete)).toThrow(/blockerId/);
  });

  it("rejects an edge with an excess property", () => {
    expect(() => parseBlockerEdgeRecord({ ...edge, weight: 1 })).toThrow(/weight/);
  });
});
