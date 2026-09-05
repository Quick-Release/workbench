import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { offlineFallbackCatalog, skillFlowEdges } from "../data/skill-flow";
import type { OverviewData, SkillsStatus, SkillRecord } from "../types";
import { FlowPage } from "./FlowPage";

const catalog: SkillRecord[] = [
  ...offlineFallbackCatalog.map((skill) => ({ ...skill, source: "matt-pocock" })),
  { id: "brand-new-skill", category: "engineering", source: "matt-pocock" },
];

const data = {
  meta: {
    projectName: "banquinha",
    theme: {} as OverviewData["meta"]["theme"],
    services: [],
    snapshot: "2026-09-05T00:00:00.000Z",
    branch: "main",
    commit: "abc1234def5678",
    repo: "Quick-Release/banquinha",
    repositoryUrl: "https://github.com/Quick-Release/banquinha",
    docsRoot: "docs",
    sources: [],
    ticketCount: 0,
    planCount: 0,
    changeCount: 0,
  },
  tickets: [],
  plans: [],
  changes: [],
  skills: catalog,
  skillInstalls: ["tdd", "implement", "grill-with-docs"],
  sessions: {
    enabled: false,
    generatedAt: "",
    perDay: [],
    perModel: [],
    sessionsByDay: [],
    sessions: [],
  },
} satisfies OverviewData;

const liveStatus = {
  sources: [
    {
      id: "matt-pocock",
      source: "mattpocock/skills",
      repositoryUrl: "https://github.com/mattpocock/skills",
      installCommand: "npx skills@latest add mattpocock/skills --all",
      installed: true,
      installedSkillCount: 3,
      totalSkillCount: catalog.length,
    },
  ],
  skills: [
    {
      id: "tdd",
      category: "engineering",
      source: "matt-pocock",
      installed: true,
      description: "Keep feedback tight from the lockfile frontmatter.",
    },
    { id: "wizard", category: "engineering", source: "matt-pocock", installed: false },
  ],
} satisfies SkillsStatus;

const renderFlow = (overrides: Partial<Parameters<typeof FlowPage>[0]> = {}) =>
  renderToString(
    <FlowPage
      data={data}
      status={liveStatus}
      pending={false}
      favorites={false}
      selected={null}
      onFavoritesChange={() => {}}
      onSelect={() => {}}
      onInstall={() => {}}
      onInstallAll={() => {}}
      {...overrides}
    />,
  );

const nodeTag = (html: string, id: string) =>
  html.match(new RegExp(`<g[^>]*data-id="${id}"[^>]*>`))?.[0] ?? "";

const withoutComments = (html: string) => html.replace(/<!-- -->/g, "");

describe("the /flow view", () => {
  it("renders one node per catalog skill and one edge per curated flow edge", () => {
    const html = renderFlow();
    expect((html.match(/data-slot="graph-node"/g) ?? []).length).toBe(catalog.length);
    expect((html.match(/data-slot="graph-edge"/g) ?? []).length).toBe(skillFlowEdges.length);
  });

  it("dims uninstalled entries against the live seam state and marks installed ones", () => {
    const html = renderFlow();
    // Live truth: tdd installed (with frontmatter description), wizard not.
    expect(nodeTag(html, "tdd")).not.toContain("dimmed");
    expect(nodeTag(html, "wizard")).toContain("dimmed");
    // skillInstalls from the snapshot covers ids the live payload omitted.
    expect(nodeTag(html, "grilling")).toContain("dimmed");
  });

  it("falls back to the sync-time installed snapshot when no dev server answers", () => {
    const html = renderFlow({ status: null });
    expect(nodeTag(html, "tdd")).not.toContain("dimmed");
    expect(nodeTag(html, "wizard")).toContain("dimmed");
    expect(html).toContain("copy the command");
    expect(html).not.toContain('data-slot="install-skill"');
    expect(html).not.toContain('data-slot="install-all"');
    expect(html).toContain("npx skills@latest add mattpocock/skills --all");
    const detail = renderFlow({ status: null, selected: "wizard" });
    expect(detail).toContain("npx skills@latest add mattpocock/skills --skill wizard");
  });

  it("lands an upstream-new skill on the standalone shelf, dimmed until installed", () => {
    const html = renderFlow({ status: null });
    const node = nodeTag(html, "brand-new-skill");
    expect(node).toContain('data-region="shelf"');
    expect(node).toContain("dimmed");
    expect(html).toContain(">unclassified<");
  });

  it("filters the graph down to the favorites with their edges", () => {
    const html = renderFlow({ favorites: true });
    const nodes = (html.match(/data-slot="graph-node"/g) ?? []).length;
    const edges = (html.match(/data-slot="graph-edge"/g) ?? []).length;
    expect(nodes).toBeLessThan(catalog.length);
    expect(nodes).toBeGreaterThan(0);
    expect(edges).toBeLessThan(skillFlowEdges.length);
    expect(edges).toBeGreaterThan(0);
    expect(html).toContain('data-id="grill-with-docs"');
    expect(html).not.toContain('data-id="wizard"');
  });

  it("opens the click-through detail with the skill's flow wiring", () => {
    const html = withoutComments(renderFlow({ selected: "implement" }));
    expect(html).toContain('data-slot="flow-detail"');
    expect(html).toContain("/implement");
    expect(html).toContain("main-flow step");
    expect(html).toContain("Engineering");
    expect(html).toContain("installed");
    expect(html).toContain("to-tickets (next step)");
    expect(html).toContain("Runs internally");
    expect(html).toContain(">tdd</button>");
    expect(html).toContain("triage (merges onto)");
  });

  it("offers the per-skill install through the seam on uninstalled detail", () => {
    const html = withoutComments(renderFlow({ selected: "wayfinder" }));
    expect(html).toContain('data-slot="install-skill"');
    expect(html).toContain("Install /wayfinder");
    expect(html).not.toContain("--skill wayfinder");
  });

  it("resolves descriptions from installed frontmatter, then the curated blurb", () => {
    const withDetail = renderFlow({ selected: "tdd" });
    expect(withDetail).toContain("Keep feedback tight from the lockfile frontmatter.");
    const curated = renderFlow({ selected: "wizard" });
    expect(curated).toContain("Generates an interactive bash script");
  });

  it("keeps the source card with install-all on the live path", () => {
    const html = withoutComments(renderFlow());
    expect(html).toContain('data-slot="install-all"');
    expect(html).toContain("Matt Pocock Skills");
    expect(html).toContain("3 of 38 installed");
  });

  it("fires no actions from a static build, offering the commands instead", () => {
    const html = renderFlow({ status: null });
    expect(html).not.toContain('data-slot="install-all"');
    expect(html).toContain("npx skills@latest add mattpocock/skills --all");
  });
});
