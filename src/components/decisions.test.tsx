import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ArtifactRecord, DecisionRecord } from "../types";
import { DecisionsPage } from "./DecisionsPage";

const adr = (id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  source: "adr",
  workItemId: null,
  title: `ADR ${id}`,
  statement: null,
  status: "accepted",
  supersedes: null,
  decidedAt: null,
  sourceRef: `docs/adr/${id.toLowerCase()}.md`,
  ...overrides,
});

const resolution = (id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  source: "resolution",
  workItemId: id,
  title: `Resolve ${id}`,
  statement: "Resolved by the ADR.",
  status: null,
  supersedes: null,
  decidedAt: "2026-09-01T12:00:00Z",
  sourceRef: `https://github.com/Quick-Release/workbench/issues/${id.slice(3)}#issuecomment-1`,
  ...overrides,
});

const artifact = (id: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  id,
  kind: "research-note",
  path: `docs/research/${id.toLowerCase()}.md`,
  title: `Note ${id}`,
  workItemId: null,
  ...overrides,
});

const renderPage = (
  decisions: readonly DecisionRecord[],
  artifacts: readonly ArtifactRecord[] = [],
) => renderToString(<DecisionsPage decisions={decisions} artifacts={artifacts} />);

const groupHtml = (html: string, workItemId: string) => {
  const marker = `data-work-item="${workItemId}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('data-slot="decision-group"', start);
  return html.slice(start, next === -1 ? html.length : next);
};

describe("the decisions view", () => {
  it("keeps resolution and ADR forms distinct and adjacent inside one work item's group", () => {
    const html = renderPage([adr("ADR-0005", { workItemId: "GH-44" }), resolution("GH-44")]);
    const group = groupHtml(html, "GH-44");
    expect(group).toContain("ADR-0005");
    expect(group).toContain("Resolve GH-44");
    expect(group).toContain('data-source="adr"');
    expect(group).toContain('data-source="resolution"');
  });

  it("renders the supersession chain with deprecated statuses visible", () => {
    const html = renderPage([
      adr("ADR-0001", { status: "superseded" }),
      adr("ADR-0002", { supersedes: "ADR-0001" }),
      adr("ADR-0003", { status: "deprecated" }),
    ]);
    expect(html).toContain("supersedes ADR-0001");
    expect(html).toContain("superseded");
    expect(html).toContain("deprecated");
  });

  it("lands unlinked records in the explicit warned group", () => {
    const html = renderPage(
      [adr("ADR-0001"), resolution("GH-42")],
      [artifact("RN-effect-adoption")],
    );
    const unlinked = html.slice(html.indexOf('data-unlinked="true"'));
    expect(unlinked).toContain("ADR-0001");
    expect(unlinked).toContain("RN-effect-adoption");
    expect(html).toContain("no Work item linkage");
    const linked = groupHtml(html, "GH-42");
    expect(linked).not.toContain("ADR-0001");
  });

  it("links artifacts to their note path", () => {
    const html = renderPage(
      [resolution("GH-42")],
      [
        artifact("RN-session-db-attribution", {
          path: "docs/research/session-db-attribution.md",
          workItemId: "GH-42",
        }),
      ],
    );
    expect(html).toContain('href="docs/research/session-db-attribution.md"');
  });

  it("carries statements uncapped", () => {
    const tail = "the closing comment runs on and on — this tail must survive rendering";
    const statement = `Resolved by ADR 0009. ${"Filler. ".repeat(40)}${tail}`;
    const html = renderPage([resolution("GH-49", { statement })]);
    expect(html).toContain(tail);
  });

  it("renders the empty state when nothing has been collected", () => {
    const html = renderPage([]);
    expect(html).toContain("No decisions collected");
  });
});
