import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MetricCard } from "./MetricCard";
import { OverviewPage } from "./OverviewPage";
import { SessionsPage } from "./SessionsPage";
import type { OverviewData } from "../types";

const sessions = {
  enabled: true,
  generatedAt: "2026-09-03T00:00:00.000Z",
  perDay: [
    {
      day: "2026-09-01",
      provider: "builtin:zai-coding-plan",
      model: "GLM-5.3-Flash",
      requests: 4,
      sessions: 2,
      inputTokens: 1000,
      outputTokens: 500,
      cacheTokens: 100,
      modelMs: 5000,
    },
  ],
  perModel: [
    {
      provider: "builtin:zai-coding-plan",
      model: "GLM-5.3-Flash",
      requests: 4,
      sessions: 2,
      inputTokens: 1000,
      outputTokens: 500,
      cacheTokens: 100,
      modelMs: 5000,
    },
  ],
  sessionsByDay: [{ day: "2026-09-01", sessions: 2 }],
  sessions: [
    {
      id: "sess_root-1",
      taskType: "interactive",
      parent: "",
      title: "Build the thing",
      directory: "/tmp/checkout",
      started: "2026-09-01T10:00:00.000Z",
      requests: 3,
      inputTokens: 900,
      outputTokens: 400,
      modelMs: 4000,
      model: "GLM-5.3-Flash",
      edits: 2,
      writes: 1,
      skillCalls: 2,
    },
    {
      id: "sess_child-1",
      taskType: "subagent_child",
      parent: "sess_root-1",
      title: "Explore side quest",
      directory: "/tmp/checkout",
      started: "2026-09-01T10:30:00.000Z",
      requests: 1,
      inputTokens: 100,
      outputTokens: 100,
      modelMs: 1000,
      model: "GLM-5.3-Flash",
      edits: 0,
      writes: 0,
      skillCalls: 1,
    },
  ],
} satisfies OverviewData["sessions"];

const sectionHtml = (html: string, label: string) => {
  const start = html.indexOf(`aria-label="${label}"`);
  const rest = html.slice(start);
  return rest.slice(0, rest.indexOf("</section>"));
};

const data = {
  meta: {
    projectName: "banquinha",
    theme: {} as OverviewData["meta"]["theme"],
    services: [],
    snapshot: "2026-08-29T15:11:41+01:00",
    branch: "main",
    commit: "abc1234def5678",
    repo: "Quick-Release/banquinha",
    repositoryUrl: "https://github.com/Quick-Release/banquinha",
    docsRoot: "docs",
    sources: [],
  },
  workItems: [],
  maps: [],
  blockerEdges: [],
  decisions: [],
  artifacts: [],
  skills: [{ id: "tdd", category: "engineering", source: "matt-pocock" }],
  skillInstalls: ["tdd"],
  sessions,
} satisfies OverviewData;

const handoffsData = {
  ...data,
  sessions: {
    ...sessions,
    sessions: [
      ...sessions.sessions,
      {
        id: "sess_lost-1",
        taskType: "subagent_child",
        parent: "sess_gone",
        title: "Follow-up from a cleared parent",
        directory: "/tmp/checkout",
        started: "2026-09-01T11:00:00.000Z",
        requests: 1,
        inputTokens: 100,
        outputTokens: 100,
        modelMs: 1000,
        model: "GLM-5.3-Flash",
        edits: 0,
        writes: 0,
        skillCalls: 0,
      },
    ],
  },
} satisfies OverviewData;

const overviewPageProps = {
  state: {
    workItems: [],
    maps: [],
    blockerEdges: [],
    decisions: [],
    artifacts: [],
    meta: { snapshot: "2026-08-29T15:11:41+01:00", repo: "Quick-Release/banquinha" },
  },
  mode: "live" as const,
  onOpenIssue: () => {},
  onSync: () => {},
  syncPending: false,
  syncMessage: null,
  syncWarnings: [],
};

const withoutComments = (html: string) => html.replace(/<!-- -->/g, "");

describe("rendered dashboard shell (shadcn rebuild)", () => {
  it("renders metric values with their tone and optional detail", () => {
    const html = renderToString(
      <MetricCard value={7} label="gates" tone="warn" detail="3 blocked" />,
    );
    expect(html).toContain(">7</strong>");
    expect(html).toContain("text-warn");
    expect(html).toContain("3 blocked");
  });

  it("composes the overview from the shadcn primitives", () => {
    const html = renderToString(<OverviewPage data={data} {...overviewPageProps} />);
    expect(html).toContain('data-slot="card"');
    expect(html).toContain('data-slot="recommendation-hero"');
    expect(html).toContain('data-slot="frontier-strip"');
  });

  it("renders the sessions page with charts and the session table", () => {
    const html = renderToString(
      <SessionsPage data={data} search={{ subagents: "all" }} onSearchChange={() => {}} />,
    );
    expect(html).toContain("Output tokens per day");
    expect(html).toContain("Model share");
    expect(html).toContain("Build the thing");
    expect(withoutComments(html)).toContain(">2</strong> of 2 sessions");
  });

  it("filters subagent sessions with the lens toggle", () => {
    const html = renderToString(
      <SessionsPage data={data} search={{ subagents: "subagents" }} onSearchChange={() => {}} />,
    );
    expect(html).not.toContain("Build the thing");
    expect(html).toContain("Explore side quest");
    expect(withoutComments(html)).toContain(">1</strong> of 2 sessions");
  });

  it("shows the disabled state when session tracking is off", () => {
    const html = renderToString(
      <SessionsPage
        data={{ ...data, sessions: { ...sessions, enabled: false } }}
        search={{ subagents: "all" }}
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("Session tracking is off");
    expect(html).not.toContain("Model share");
  });

  it("renders the handoffs lens as trees with boundaries and skill calls", () => {
    const html = renderToString(
      <SessionsPage
        data={handoffsData}
        search={{ subagents: "handoffs" }}
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Session handoffs"');
    // The tree: parent above child, the recorded boundary between them.
    expect(html).toContain("Build the thing");
    expect(html).toContain("Explore side quest");
    expect(html).toContain("2 skill calls");
    expect(html).toContain("1 skill call");
    // Two recorded parent links: the in-view join and the out-of-view one.
    expect(withoutComments(html)).toContain(">2</strong> handoff boundaries");
    // A parent outside the view renders naming the gap, never silently.
    expect(html).toContain("sess_gone");
    expect(html).toContain("not in this view");
  });

  it("renders no action affordances in the handoffs lens — sessions stay observed", () => {
    const html = renderToString(
      <SessionsPage
        data={handoffsData}
        search={{ subagents: "handoffs" }}
        onSearchChange={() => {}}
      />,
    );
    // The heading's toggle is view navigation shared with the table lens;
    // everything the lens shows about the sessions themselves carries no
    // way to act.
    const section = sectionHtml(html, "Session handoffs");
    const fromSummary = section.slice(section.indexOf('class="result-line"'));
    expect(fromSummary).not.toContain("<button");
    expect(fromSummary).not.toContain("<a ");
    expect(fromSummary).not.toContain("<form");
  });

  it("keeps the handoffs lens out of the disabled state", () => {
    const html = renderToString(
      <SessionsPage
        data={{ ...handoffsData, sessions: { ...handoffsData.sessions, enabled: false } }}
        search={{ subagents: "handoffs" }}
        onSearchChange={() => {}}
      />,
    );
    expect(html).toContain("Session tracking is off");
    expect(html).not.toContain('aria-label="Session handoffs"');
  });
});
