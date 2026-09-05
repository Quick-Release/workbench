import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adrDecisionFromText,
  artifactFromResearchFile,
  collectAdrDecisions,
  collectResearchArtifacts,
  resolutionDecisionFromIssue,
  sortDecisions,
  specDecisionFromIssue,
} from "./tracker/decisions.mjs";
import { DEFAULT_WORKFLOW_VOCABULARY } from "./tracker/labels.mjs";
import { collectTrackerState } from "./tracker/index.mjs";
import { fetchIssueComments } from "./tracker/issues.mjs";

const adrText = (overrides = {}) => `# Blocker edges and the frontier

Status: accepted

Work item: GH-47

Supersedes: ADR-0003

Ticket #47 asked how blocker edges enter the snapshot.
${overrides.trailing ?? ""}`;

const adr = (filename, text) =>
  adrDecisionFromText({ filename, text, sourceRef: `docs/adr/${filename}` });

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("an ADR file parses into a decision record with title, status, linkage, and supersedes", () => {
  const { record, warnings } = adr("0008-blocker-edges-and-the-frontier.md", adrText());

  deepStrictEqual(warnings, []);
  strictEqual(record.id, "ADR-0008");
  strictEqual(record.source, "adr");
  strictEqual(record.title, "Blocker edges and the frontier");
  strictEqual(record.status, "accepted");
  strictEqual(record.workItemId, "GH-47");
  strictEqual(record.supersedes, "ADR-0003");
  strictEqual(record.statement, null);
  strictEqual(record.decidedAt, null);
  strictEqual(record.sourceRef, "docs/adr/0008-blocker-edges-and-the-frontier.md");
});

test("a missing or unparsable ADR status loads with null status and a warning", () => {
  const missing = adr("0001-telemetry.md", "# Telemetry\n\nNo status here.\n");
  strictEqual(missing.record.status, null);
  match(missing.warnings.join("\n"), /ADR-0001/);
  match(missing.warnings.join("\n"), /[Ss]tatus/);

  const unparsable = adr("0002-thing.md", "# Thing\n\nStatus: probably fine\n");
  strictEqual(unparsable.record.status, null);
  match(unparsable.warnings.join("\n"), /probably fine/);
});

test("a missing Work item line loads with null linkage and a warning", () => {
  const { record, warnings } = adr(
    "0005-control-surface.md",
    "# Control surface\n\nStatus: accepted\n",
  );

  match(warnings.join("\n"), /ADR-0005/);
  match(warnings.join("\n"), /work item/i);
  strictEqual(record.workItemId, null);
});

test("a Supersedes line without a parsable ADR reference warns and stays null", () => {
  const { record, warnings } = adr(
    "0006-flow.md",
    "# Flow\n\nStatus: accepted\n\nSupersedes: the old plan\n",
  );

  match(warnings.join("\n"), /Supersedes/);
  strictEqual(record.supersedes, null);
});

test("no Supersedes line stays null without a warning", () => {
  const { record, warnings } = adr(
    "0007-labels.md",
    "# Labels\n\nStatus: proposed\n\nWork item: GH-46\n",
  );

  deepStrictEqual(warnings, []);
  strictEqual(record.status, "proposed");
  strictEqual(record.supersedes, null);
});

test("the ADR walk takes every top-level NNNN-slug.md, sorted, ignoring other files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wb-adr-"));
  try {
    await writeFile(join(directory, "0002-second.md"), "# Second\n\nStatus: accepted\n");
    await writeFile(join(directory, "0001-first.md"), "# First\n\nStatus: superseded\n");
    await writeFile(join(directory, "notes.md"), "# Not an ADR\n");
    await writeFile(join(directory, "readme.txt"), "not markdown");
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "0003-deep.md"), "# Deep\n");

    const { decisions, exists } = await collectAdrDecisions({ directory });

    strictEqual(exists, true);
    deepStrictEqual(
      decisions.map((record) => record.id),
      ["ADR-0001", "ADR-0002"],
    );
    strictEqual(decisions[0].status, "superseded");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a host repo without the ADR convention fails soft to empty with exists false", async () => {
  const { decisions, warnings, exists } = await collectAdrDecisions({
    directory: join(tmpdir(), "wb-missing-adr"),
  });

  deepStrictEqual(decisions, []);
  deepStrictEqual(warnings, []);
  strictEqual(exists, false);
});

test("a spec issue bundles its Implementation-Decisions section as one record", () => {
  const issue = {
    number: 54,
    title: "Skills-ecosystem dashboard: build spec",
    html_url: "https://github.com/example/project/issues/54",
    body: "## Problem Statement\n\nSomething.\n\n## Implementation Decisions\n\n- one\n- two\n- three\n",
  };

  const record = specDecisionFromIssue(issue);

  strictEqual(record.id, "GH-54");
  strictEqual(record.source, "spec");
  strictEqual(record.workItemId, "GH-54");
  strictEqual(record.title, "Skills-ecosystem dashboard: build spec");
  strictEqual(record.statement, null);
  strictEqual(record.status, null);
  strictEqual(record.supersedes, null);
  strictEqual(record.decidedAt, null);
  strictEqual(record.sourceRef, "https://github.com/example/project/issues/54");
});

test("an issue without an Implementation-Decisions section is never a spec bundle", () => {
  strictEqual(
    specDecisionFromIssue({
      number: 60,
      title: "Panel",
      body: "## What to build\n\nPanel stuff.\n",
    }),
    null,
  );
  strictEqual(specDecisionFromIssue({ number: 61, body: null }), null);
});

test("the closing comment of a resolved decision ticket becomes its resolution record", () => {
  const issue = {
    number: 49,
    title: "Resolve decision and artifact modeling",
    state: "closed",
  };
  const comments = [
    {
      body: "Thinking out loud mid-thread.",
      created_at: "2026-09-01T10:00:00Z",
      html_url: "https://github.com/example/project/issues/49#issuecomment-1",
    },
    {
      body: "Resolved by ADR 0009 — `docs/adr/0009-decisions-and-artifacts-collect-at-sync.md`.\n\n**The decision.** Sync collects two top-level snapshot arrays.",
      created_at: "2026-09-02T12:00:00Z",
      html_url: "https://github.com/example/project/issues/49#issuecomment-2",
    },
  ];

  const record = resolutionDecisionFromIssue({ issue, comments });

  strictEqual(record.id, "GH-49");
  strictEqual(record.source, "resolution");
  strictEqual(record.workItemId, "GH-49");
  strictEqual(record.title, "Resolve decision and artifact modeling");
  match(record.statement, /Resolved by ADR 0009/);
  ok(record.statement.length > 100, "the statement carries the full comment uncapped");
  strictEqual(record.status, null);
  strictEqual(record.supersedes, null);
  strictEqual(record.decidedAt, "2026-09-02T12:00:00Z");
  strictEqual(record.sourceRef, "https://github.com/example/project/issues/49#issuecomment-2");
});

test("a closed ticket without comments yields no resolution record", () => {
  strictEqual(
    resolutionDecisionFromIssue({ issue: { number: 51, title: "T" }, comments: [] }),
    null,
  );
});

test("a research note becomes an artifact with an RN slug id and optional silent linkage", () => {
  const linked = artifactFromResearchFile({
    filename: "session-db-attribution.md",
    text: "# What the Session Database Can Attribute\n\nWork item: GH-42\n\n## Question\n",
    rootDirectory: "/repo",
  });

  strictEqual(linked.record.id, "RN-session-db-attribution");
  strictEqual(linked.record.kind, "research-note");
  strictEqual(linked.record.path, "docs/research/session-db-attribution.md");
  strictEqual(linked.record.title, "What the Session Database Can Attribute");
  strictEqual(linked.record.workItemId, "GH-42");
  deepStrictEqual(linked.warnings, []);

  const unlinked = artifactFromResearchFile({
    filename: "graph-rendering.md",
    text: "# Graph rendering\n",
    rootDirectory: "/repo",
  });

  strictEqual(unlinked.record.workItemId, null);
  deepStrictEqual(unlinked.warnings, []);
});

test("the research walk collects every top-level note sorted with repo-relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "wb-research-"));
  try {
    const directory = join(root, "docs", "research");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "b-second.md"), "# Second note\n");
    await writeFile(join(directory, "a-first.md"), "# First note\n");

    const { artifacts, exists } = await collectResearchArtifacts({
      directory,
      rootDirectory: root,
    });

    strictEqual(exists, true);
    deepStrictEqual(
      artifacts.map((artifact) => artifact.id),
      ["RN-a-first", "RN-b-second"],
    );
    strictEqual(artifacts[0].path, "docs/research/a-first.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a host repo without the research convention fails soft to empty with exists false", async () => {
  const { artifacts, exists } = await collectResearchArtifacts({
    directory: join(tmpdir(), "wb-missing-research"),
    rootDirectory: tmpdir(),
  });

  deepStrictEqual(artifacts, []);
  strictEqual(exists, false);
});

test("decision records sort ADR numbers before tracker ids, each numerically", () => {
  const sorted = sortDecisions([
    { id: "GH-9", source: "resolution" },
    { id: "ADR-0002", source: "adr" },
    { id: "GH-10", source: "spec" },
    { id: "ADR-0010", source: "adr" },
  ]);

  deepStrictEqual(
    sorted.map((record) => record.id),
    ["ADR-0002", "ADR-0010", "GH-9", "GH-10"],
  );
});

// The tracker-side half: map sub-issue enumeration plus targeted comment
// reads of closed children, and spec bundles over the issues already read.
const routeFetch = ({
  openPages = [[]],
  maps = [],
  subIssues = {},
  singles = {},
  comments = {},
  defaultComments = null,
  commentsStatus = null,
  status = 200,
}) => {
  const calls = [];
  let sweepPage = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith("/comments")) {
      const number = u.pathname.match(/\/issues\/(\d+)\/comments$/)[1];
      return jsonResponse(comments[number] ?? defaultComments ?? [], commentsStatus ?? status);
    }
    if (u.pathname.endsWith("/sub_issues")) {
      const number = u.pathname.match(/\/issues\/(\d+)\/sub_issues$/)[1];
      return jsonResponse(subIssues[number] ?? [], status);
    }
    const single = u.pathname.match(/\/issues\/(\d+)$/);
    if (single) return jsonResponse(singles[single[1]] ?? null, status);
    if (u.searchParams.get("labels") === "wayfinder:map") return jsonResponse(maps, status);
    const page = openPages[Math.min(sweepPage, openPages.length - 1)];
    sweepPage += 1;
    return jsonResponse(page, status);
  };
  return { fetchImpl, calls };
};

const issue = (number, overrides = {}) => ({
  number,
  title: `Issue ${number}`,
  state: "open",
  labels: [],
  body: `Body of issue ${number}.`,
  html_url: `https://github.com/example/project/issues/${number}`,
  assignees: [],
  ...overrides,
});

const collect = (overrides = {}) =>
  collectTrackerState({
    repo: "example/project",
    env: { GITHUB_TOKEN: "secret" },
    ghToken: async () => "",
    vocabulary: DEFAULT_WORKFLOW_VOCABULARY,
    ...overrides,
  });

test("closed map children yield resolution records; open children and comment-less tickets yield none", async () => {
  const { fetchImpl, calls } = routeFetch({
    openPages: [[]],
    maps: [issue(41, { labels: [{ name: "wayfinder:map" }] })],
    subIssues: {
      41: [
        issue(49, { state: "closed" }),
        issue(58, { state: "open" }),
        issue(60, { state: "closed", body: null }),
      ],
    },
    comments: {
      49: [
        {
          body: "Resolved by ADR 0009.",
          created_at: "2026-09-02T12:00:00Z",
          html_url: "https://github.com/example/project/issues/49#issuecomment-2",
        },
      ],
      58: [{ body: "still open chatter", created_at: "2026-09-01T00:00:00Z", html_url: "u" }],
    },
  });

  const { decisions, warnings } = await collect({ fetchImpl });

  deepStrictEqual(warnings, []);
  deepStrictEqual(
    decisions.map((record) => [record.id, record.source]),
    [["GH-49", "resolution"]],
  );
  const commentCalls = calls.filter((u) => u.pathname.endsWith("/comments"));
  deepStrictEqual(
    commentCalls.map((u) => u.pathname),
    ["/repos/example/project/issues/49/comments", "/repos/example/project/issues/60/comments"],
  );
});

test("a spec issue's bundle arrives from the sweep as one spec-source record", async () => {
  const { fetchImpl } = routeFetch({
    openPages: [
      [
        issue(54, {
          title: "Skills-ecosystem dashboard: build spec",
          body: "## Implementation Decisions\n\n- the sequencing\n- the seams\n",
        }),
        issue(55, { title: "Tracker adapter" }),
      ],
    ],
  });

  const { decisions } = await collect({ fetchImpl });

  deepStrictEqual(
    decisions.map((record) => [record.id, record.source]),
    [["GH-54", "spec"]],
  );
  strictEqual(decisions[0].title, "Skills-ecosystem dashboard: build spec");
});

test("spec bundles and resolutions dedupe across sweep, membership, and targeted reads", async () => {
  const { fetchImpl } = routeFetch({
    openPages: [[]],
    maps: [issue(41, { labels: [{ name: "wayfinder:map" }] })],
    subIssues: {
      41: [issue(54, { state: "closed", body: "## Implementation Decisions\n\n- x\n" })],
    },
    comments: {
      54: [
        { body: "Resolved by the spec itself.", created_at: "2026-09-03T00:00:00Z", html_url: "u" },
      ],
    },
  });

  const { decisions } = await collect({ fetchImpl });

  deepStrictEqual(
    decisions.map((record) => [record.id, record.source]),
    [
      ["GH-54", "resolution"],
      ["GH-54", "spec"],
    ],
  );
});

test("a failing comments read warns and never fails sync", async () => {
  const { fetchImpl } = routeFetch({
    openPages: [[]],
    maps: [issue(41, { labels: [{ name: "wayfinder:map" }] })],
    subIssues: { 41: [issue(49, { state: "closed" })] },
    commentsStatus: 500,
  });

  const { decisions, warnings } = await collect({ fetchImpl });

  deepStrictEqual(decisions, []);
  match(warnings.join("\n"), /GH-49/);
  match(warnings.join("\n"), /HTTP 500|unavailable/);
});

test("comment reads share the targeted-read cap with work-item reads and warn at the cap", async () => {
  const members = Array.from({ length: 260 }, (_, index) =>
    issue(index + 200, { state: "closed" }),
  );
  const { fetchImpl } = routeFetch({
    openPages: [[]],
    maps: [issue(100, { labels: [{ name: "wayfinder:map" }] })],
    subIssues: { 100: members },
    defaultComments: [{ body: "Resolution.", created_at: "2026-09-02T00:00:00Z", html_url: "u" }],
  });

  const { decisions, warnings } = await collect({ fetchImpl, maxPages: 1 });

  // 250 reads of budget, two per closed member (work item + comments): the
  // first 125 children yield resolutions, the rest are capped and warned.
  strictEqual(decisions.length, 125);
  strictEqual(
    warnings.some((warning) => /250 cap/.test(warning)),
    true,
  );
  match(warnings.join("\n"), /resolution/i);
});

test("fetchIssueComments pages under the cap and filters to real comments", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    const page = new URL(url).searchParams.get("page");
    return jsonResponse(
      page === "1"
        ? Array.from({ length: 100 }, (_, i) => ({ body: `c${i}`, created_at: "t", html_url: "u" }))
        : [{ body: "last", created_at: "t2", html_url: "u2" }, { nope: true }],
    );
  };

  const { comments, warnings } = await fetchIssueComments({
    repo: "example/project",
    token: "secret",
    apiBase: "https://api.github.com",
    issueNumber: 49,
    fetchImpl,
    maxPages: 5,
  });

  deepStrictEqual(warnings, []);
  strictEqual(comments.length, 101);
  strictEqual(comments[100].body, "last");
  strictEqual(calls[0].searchParams.get("per_page"), "100");
});

test("fetchIssueComments degrades on a failed page with what it collected", async () => {
  let first = true;
  const { comments, warnings } = await fetchIssueComments({
    repo: "example/project",
    token: "secret",
    apiBase: "https://api.github.com",
    issueNumber: 49,
    fetchImpl: async () => {
      if (first) {
        first = false;
        return jsonResponse(
          Array.from({ length: 100 }, (_, i) => ({
            body: `c${i}`,
            created_at: "t",
            html_url: "u",
          })),
        );
      }
      throw new Error("HTTP 502");
    },
    maxPages: 5,
  });

  strictEqual(comments.length, 100);
  match(warnings.join("\n"), /HTTP 502/);
});
