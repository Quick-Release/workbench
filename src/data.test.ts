import { describe, expect, it } from "vite-plus/test";

import { overviewData } from "./data";
import { overviewData as generatedData } from "./data.generated";
import { offlineFallbackCatalog, skillFlowClassification, skillFlowEdges } from "./data/skill-flow";
import {
  parseOverviewData,
  parseSkillClassification,
  parseSkillFlowEdge,
  parseSkillRecord,
  parseSkillsStatus,
  parseTicketRecord,
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

describe("skills catalog boundary", () => {
  it("decodes a skill record with its source", () => {
    expect(parseSkillRecord({ id: "tdd", category: "engineering", source: "matt-pocock" })).toEqual(
      { id: "tdd", category: "engineering", source: "matt-pocock" },
    );
  });

  it("rejects a skill record with an excess field and a missing category", () => {
    expect(() => parseSkillRecord({ id: "tdd", extra: true })).toThrow(/extra/);
    expect(() => parseSkillRecord({ id: "tdd", source: "matt-pocock" })).toThrow(/category/);
  });

  it("decodes a skill flow edge only over the six-verb vocabulary", () => {
    expect(parseSkillFlowEdge({ from: "implement", to: "tdd", kind: "runs-internally" })).toEqual({
      from: "implement",
      to: "tdd",
      kind: "runs-internally",
    });
    expect(() => parseSkillFlowEdge({ from: "a", to: "b", kind: "requires" })).toThrow(/kind/);
    expect(() =>
      parseSkillFlowEdge({ from: "a", to: "b", kind: "next-step", dashed: true }),
    ).toThrow(/dashed/);
  });

  it("accepts every curated classification entry and flow edge through the schemas", () => {
    expect(Object.keys(skillFlowClassification).length).toBe(offlineFallbackCatalog.length);
    for (const entry of Object.values(skillFlowClassification)) {
      expect(() => parseSkillClassification(entry)).not.toThrow();
    }
    for (const edge of skillFlowEdges) {
      expect(() => parseSkillFlowEdge(edge)).not.toThrow();
    }
  });

  it("keeps every flow edge endpoint inside the curated catalog", () => {
    const ids = new Set(offlineFallbackCatalog.map((skill) => skill.id));
    for (const edge of skillFlowEdges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it("decodes the generated catalog and installed snapshot on import", () => {
    expect(generatedData.skills.length).toBeGreaterThanOrEqual(offlineFallbackCatalog.length);
    expect(generatedData.skills.every((skill) => skill.category.length > 0)).toBe(true);
    expect(Array.isArray(generatedData.skillInstalls)).toBe(true);
  });

  it("rejects a generated payload whose catalog entry carries an unknown category field", () => {
    const drifted: unknown = {
      ...generatedData,
      skills: [{ id: "tdd", category: "engineering", source: "matt-pocock", blurb: "x" }],
    };
    expectRejected(drifted, /blurb/);
  });

  it("decodes the execution-seam skills payload with live installed state", () => {
    const status = {
      sources: [
        {
          id: "matt-pocock",
          source: "mattpocock/skills",
          repositoryUrl: "https://github.com/mattpocock/skills",
          installCommand: "npx skills@latest add mattpocock/skills --all",
          installed: true,
          installedSkillCount: 1,
          totalSkillCount: 1,
        },
      ],
      skills: [
        {
          id: "tdd",
          category: "engineering",
          source: "matt-pocock",
          installed: true,
          description: "Tight loops.",
        },
        { id: "wizard", category: "engineering", source: "matt-pocock", installed: false },
      ],
    };
    expect(parseSkillsStatus(status).skills).toHaveLength(2);
  });

  it("rejects a seam payload with an unknown field, a bad installed flag, or a non-numeric count", () => {
    const base = {
      sources: [
        {
          id: "matt-pocock",
          source: "mattpocock/skills",
          repositoryUrl: "https://github.com/mattpocock/skills",
          installCommand: "npx skills@latest add mattpocock/skills --all",
          installed: false,
          installedSkillCount: 0,
          totalSkillCount: 1,
        },
      ],
      skills: [{ id: "tdd", category: "engineering", source: "matt-pocock", installed: true }],
    };
    expect(() => parseSkillsStatus(base)).not.toThrow();
    expect(() => parseSkillsStatus({ ...base, unexpected: true })).toThrow(/excess/);
    expect(() =>
      parseSkillsStatus({ ...base, skills: [{ ...base.skills[0], installed: "yes" }] }),
    ).toThrow(/installed/);
    expect(() =>
      parseSkillsStatus({
        ...base,
        sources: [{ ...base.sources[0], installedSkillCount: "many" }],
      }),
    ).toThrow(/installedSkillCount/i);
  });
});
