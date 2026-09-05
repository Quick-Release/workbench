import { describe, expect, it } from "vite-plus/test";

import { overviewData } from "./data";
import { overviewData as generatedData } from "./data.generated";
import {
  frontier,
  frontierItemFromTicket,
  frontierItemFromWorkItem,
  openBlockers,
} from "./lib/frontier";
import {
  parseArtifactRecord,
  parseBlockerEdgeRecord,
  parseDecisionRecord,
  parseIssueCommentRequest,
  parseIssueCommentResult,
  parseIssueCreateRequest,
  parseIssueCreateResult,
  parseIssueEditRequest,
  parseIssueEditResult,
  parseOverviewData,
  parseTicketRecord,
  parseTriageMoveRequest,
  parseTriageMoveResult,
  parseTrackerMapRecord,
  parseWorkItemRecord,
  parseWorkflowStatePayload,
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

  it("rejects data missing the decisions key entirely", () => {
    const { decisions: _omitted, ...withoutDecisions } = generatedData;
    expectRejected(withoutDecisions, /decisions/);
  });

  it("rejects data missing the artifacts key entirely", () => {
    const { artifacts: _omitted, ...withoutArtifacts } = generatedData;
    expectRejected(withoutArtifacts, /artifacts/);
  });

  it("carries decisions and artifacts from the generated snapshot", () => {
    expect(Array.isArray(generatedData.decisions)).toBe(true);
    expect(Array.isArray(generatedData.artifacts)).toBe(true);
    for (const record of generatedData.decisions) expect(parseDecisionRecord(record)).toBeTruthy();
    for (const record of generatedData.artifacts) expect(parseArtifactRecord(record)).toBeTruthy();
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

  it("names a sound grabbable set over the real snapshot", () => {
    const items = [
      ...generatedData.workItems.map(frontierItemFromWorkItem),
      ...generatedData.tickets.map(frontierItemFromTicket),
    ];
    const byId = new Map(items.map((item) => [item.id, item]));
    const grabbable = frontier(items, generatedData.blockerEdges, generatedData.maps).map(
      (item) => item.id,
    );

    for (const id of grabbable) {
      const item = byId.get(id);
      expect(item?.open).toBe(true);
      expect(item?.assignees).toEqual([]);
      const { open, dangling } = openBlockers(
        id,
        generatedData.blockerEdges,
        new Map(items.map((entry) => [entry.id, entry])),
      );
      expect([...open, ...dangling]).toEqual([]);
    }
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

describe("decision record boundary", () => {
  const adr = {
    id: "ADR-0009",
    source: "adr",
    workItemId: "GH-49",
    title: "Decisions and artifacts collect at sync",
    statement: null,
    status: "accepted",
    supersedes: null,
    decidedAt: null,
    sourceRef: "docs/adr/0009-decisions-and-artifacts-collect-at-sync.md",
  };

  const resolution = {
    id: "GH-49",
    source: "resolution",
    workItemId: "GH-49",
    title: "Resolve decision and artifact modeling",
    statement: "Resolved by ADR 0009 — docs/adr/0009-….md.",
    status: null,
    supersedes: null,
    decidedAt: "2026-09-02T12:00:00Z",
    sourceRef: "https://github.com/Quick-Release/workbench/issues/49#issuecomment-2",
  };

  it("accepts an ADR record with status and declared linkage", () => {
    expect(parseDecisionRecord(adr)).toEqual(adr);
  });

  it("accepts a resolution record carrying its full uncapped statement", () => {
    expect(parseDecisionRecord(resolution)).toEqual(resolution);
  });

  it("accepts a spec bundle record", () => {
    expect(
      parseDecisionRecord({
        ...resolution,
        id: "GH-54",
        source: "spec",
        title: "Skills-ecosystem dashboard: build spec",
        statement: null,
        decidedAt: null,
        sourceRef: "https://github.com/Quick-Release/workbench/issues/54",
      }),
    ).toEqual(expect.objectContaining({ source: "spec", statement: null }));
  });

  it("rejects an unknown decision source", () => {
    expect(() => parseDecisionRecord({ ...adr, source: "gist" })).toThrow(/source/);
  });

  it("rejects an unknown ADR status", () => {
    expect(() => parseDecisionRecord({ ...adr, status: "ratified" })).toThrow(/status/);
  });

  it("rejects a decision record with an excess property", () => {
    expect(() => parseDecisionRecord({ ...adr, bullets: [] })).toThrow(/bullets/);
  });

  it("rejects a decision record missing its provenance", () => {
    const { sourceRef: _omitted, ...incomplete } = adr;
    expect(() => parseDecisionRecord(incomplete)).toThrow(/sourceRef/);
  });
});

describe("artifact record boundary", () => {
  const artifact = {
    id: "RN-session-db-attribution",
    kind: "research-note",
    path: "docs/research/session-db-attribution.md",
    title: "What the Session Database Can Attribute",
    workItemId: "GH-42",
  };

  it("accepts a research-note artifact with its linkage", () => {
    expect(parseArtifactRecord(artifact)).toEqual(artifact);
  });

  it("accepts an artifact without linkage", () => {
    expect(parseArtifactRecord({ ...artifact, workItemId: null })).toEqual(
      expect.objectContaining({ workItemId: null }),
    );
  });

  it("rejects an unknown artifact kind", () => {
    expect(() => parseArtifactRecord({ ...artifact, kind: "handoff-doc" })).toThrow(/kind/);
  });

  it("rejects an artifact with an excess property", () => {
    expect(() => parseArtifactRecord({ ...artifact, sha: "abc" })).toThrow(/sha/);
  });

  it("rejects an artifact missing its path", () => {
    const { path: _omitted, ...incomplete } = artifact;
    expect(() => parseArtifactRecord(incomplete)).toThrow(/path/);
  });
});

describe("workflow seam payload boundary", () => {
  const workItem = {
    id: "GH-59",
    title: "Workflow read seam and the triage view",
    url: "https://github.com/Quick-Release/workbench/issues/59",
    state: "open",
    assignees: [],
    phase: "ticketed",
    triageState: "ready-for-agent",
    deferred: false,
    category: "enhancement",
    kind: null,
    summary: "The execution seam serves workflow state.",
  };

  const payload = {
    workItems: [workItem],
    maps: [
      {
        mapId: "GH-41",
        title: "Skills-ecosystem dashboard",
        url: "https://github.com/Quick-Release/workbench/issues/41",
        ticketIds: ["GH-59"],
      },
    ],
    blockerEdges: [
      {
        blockedId: "GH-60",
        blockerId: "GH-59",
        source: "github-native",
        sourceRef: "https://github.com/Quick-Release/workbench/issues/60",
      },
    ],
    meta: { snapshot: "2026-09-05T12:00:00+01:00", repo: "Quick-Release/workbench" },
  };

  it("accepts the joined read payload over synced records", () => {
    expect(parseWorkflowStatePayload(payload)).toEqual(payload);
  });

  it("rejects a payload with an excess top-level key", () => {
    expect(() => parseWorkflowStatePayload({ ...payload, tickets: [] })).toThrow(/tickets/);
  });

  it("rejects a payload whose records carry excess properties", () => {
    const drifted: unknown = {
      ...payload,
      workItems: [{ ...workItem, dependencies: "GH-55" }],
    };
    expect(() => parseWorkflowStatePayload(drifted)).toThrow(/dependencies/);
  });

  it("rejects a payload with an unknown triage state on a record", () => {
    const drifted: unknown = {
      ...payload,
      workItems: [{ ...workItem, triageState: "ready" }],
    };
    expect(() => parseWorkflowStatePayload(drifted)).toThrow(/triageState/);
  });

  it("rejects a payload missing its provenance stamp", () => {
    const { snapshot: _omitted, ...headless } = payload.meta;
    const drifted: unknown = { ...payload, meta: headless };
    expect(() => parseWorkflowStatePayload(drifted)).toThrow(/snapshot/);
  });
});

describe("triage move request boundary", () => {
  it("accepts a minimal label move", () => {
    expect(parseTriageMoveRequest({ issueId: "GH-59", triageState: "needs-info" })).toEqual({
      issueId: "GH-59",
      triageState: "needs-info",
    });
  });

  it("accepts a confirmed destructive move", () => {
    expect(
      parseTriageMoveRequest({ issueId: "GH-59", triageState: "wontfix", confirm: true }),
    ).toEqual(expect.objectContaining({ triageState: "wontfix", confirm: true }));
  });

  it("rejects an unknown target triage state", () => {
    expect(() => parseTriageMoveRequest({ issueId: "GH-59", triageState: "ready" })).toThrow(
      /triageState/,
    );
  });

  it("rejects a request with an excess property", () => {
    expect(() =>
      parseTriageMoveRequest({ issueId: "GH-59", triageState: "wontfix", force: true }),
    ).toThrow(/force/);
  });

  it("rejects a request without its work item", () => {
    expect(() => parseTriageMoveRequest({ triageState: "needs-info" })).toThrow(/issueId/);
  });
});

describe("triage move result boundary", () => {
  const result = {
    message: "Moved GH-59 to ready-for-agent.",
    issueId: "GH-59",
    triageState: "ready-for-agent",
    state: {
      workItems: [],
      maps: [],
      blockerEdges: [],
      meta: { snapshot: "2026-09-05T12:00:00+01:00", repo: "Quick-Release/workbench" },
    },
  };

  it("accepts a move result carrying the updated state", () => {
    expect(parseTriageMoveResult(result)).toEqual(result);
  });

  it("rejects a result with an excess property", () => {
    expect(() => parseTriageMoveResult({ ...result, undo: true })).toThrow(/undo/);
  });

  it("rejects a result whose state fails the payload schema", () => {
    const drifted: unknown = { ...result, state: { ...result.state, meta: {} } };
    expect(() => parseTriageMoveResult(drifted)).toThrow(/snapshot/);
  });
});

describe("issue action request boundaries", () => {
  it("accepts an edit with its fields and confirmation", () => {
    expect(
      parseIssueEditRequest({ issueId: "GH-60", title: "T", body: "B", confirm: true }),
    ).toEqual({ issueId: "GH-60", title: "T", body: "B", confirm: true });
  });

  it("accepts an edit that names only the fields being written", () => {
    expect(parseIssueEditRequest({ issueId: "GH-60", title: "T" })).toEqual({
      issueId: "GH-60",
      title: "T",
    });
    expect(parseIssueEditRequest({ issueId: "GH-60" })).toEqual({ issueId: "GH-60" });
  });

  it("rejects an edit with an excess property", () => {
    expect(() => parseIssueEditRequest({ issueId: "GH-60", state: "open" })).toThrow(/state/);
  });

  it("accepts a comment request and rejects a drifted one", () => {
    expect(parseIssueCommentRequest({ issueId: "GH-60", body: "Settled." })).toEqual({
      issueId: "GH-60",
      body: "Settled.",
    });
    expect(() => parseIssueCommentRequest({ issueId: 60, body: "Settled." })).toThrow(/issueId/);
    expect(() => parseIssueCommentRequest({ issueId: "GH-60", body: "hi", undo: true })).toThrow(
      /undo/,
    );
  });

  it("accepts a create request without a body and rejects a drifted one", () => {
    expect(parseIssueCreateRequest({ title: "Fresh capture" })).toEqual({
      title: "Fresh capture",
    });
    expect(parseIssueCreateRequest({ title: "Fresh capture", body: "The body." })).toEqual({
      title: "Fresh capture",
      body: "The body.",
    });
    expect(() => parseIssueCreateRequest({ body: "no title" })).toThrow(/title/);
    expect(() => parseIssueCreateRequest({ title: "x", labels: ["bug"] })).toThrow(/labels/);
  });
});

describe("issue action result boundaries", () => {
  const state = {
    workItems: [],
    maps: [],
    blockerEdges: [],
    meta: { snapshot: "2026-09-05T12:00:00+01:00", repo: "Quick-Release/workbench" },
  };

  it("accepts an edit result carrying the updated state and rejects drift", () => {
    const result = { message: "GH-60 updated.", issueId: "GH-60", state };
    expect(parseIssueEditResult(result)).toEqual(result);
    expect(() => parseIssueEditResult({ ...result, extra: 1 })).toThrow(/extra/);
  });

  it("accepts a comment result with the comment url and rejects drift", () => {
    const result = {
      message: "Commented on GH-60.",
      issueId: "GH-60",
      commentUrl: "https://github.com/Quick-Release/workbench/issues/60#issuecomment-1",
    };
    expect(parseIssueCommentResult(result)).toEqual(result);
    expect(() => parseIssueCommentResult({ ...result, commentId: 1 })).toThrow(/commentId/);
  });

  it("accepts a create result carrying the new issue and rejects drift", () => {
    const result = { message: "GH-99 created.", issueId: "GH-99", state };
    expect(parseIssueCreateResult(result)).toEqual(result);
    const drifted: unknown = { ...result, state: { ...state, meta: {} } };
    expect(() => parseIssueCreateResult(drifted)).toThrow(/snapshot/);
  });
});
