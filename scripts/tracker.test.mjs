import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DECISION_PLACEMENT,
  DEFAULT_WORKFLOW_VOCABULARY,
  decisionPlacementFromMarkdown,
  deriveWorkItem,
  loadDecisionPlacement,
  loadWorkflowVocabulary,
  phaseFromLabels,
  workflowVocabularyFromMarkdown,
} from "./tracker/labels.mjs";
import { collectTrackerState } from "./tracker/index.mjs";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

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

// Routes the tracker's read shapes: the open-issue sweep, any label-filtered
// query (wayfinder:map, the two client labels), per-issue sub_issues lists,
// targeted single reads, and the open-pull-requests walk.
const routeFetch = ({
  openPages = [[]],
  labelPages = {},
  maps = [],
  subIssues = {},
  singles = {},
  pulls = [],
  status = 200,
}) => {
  const calls = [];
  let sweepPage = 0;
  const labelSeen = {};
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const label = u.searchParams.get("labels");
    if (label === "wayfinder:map") return jsonResponse(maps, status);
    if (label !== null) {
      const pages = labelPages[label] ?? [];
      const index = Math.min(labelSeen[label] ?? 0, pages.length - 1);
      labelSeen[label] = index + 1;
      return jsonResponse(pages[index] ?? [], status);
    }
    if (u.pathname.endsWith("/pulls")) return jsonResponse(pulls, status);
    if (u.pathname.endsWith("/sub_issues")) {
      const number = u.pathname.match(/\/issues\/(\d+)\/sub_issues$/)[1];
      return jsonResponse(subIssues[number] ?? [], status);
    }
    const single = u.pathname.match(/\/issues\/(\d+)$/);
    if (single) return jsonResponse(singles[single[1]] ?? null, status);
    const page = openPages[Math.min(sweepPage, openPages.length - 1)];
    sweepPage += 1;
    return jsonResponse(page, status);
  };
  return { fetchImpl, calls };
};

const collect = (overrides = {}) =>
  collectTrackerState({
    repo: "example/project",
    env: { GITHUB_TOKEN: "secret" },
    ghToken: async () => "",
    vocabulary: DEFAULT_WORKFLOW_VOCABULARY,
    ...overrides,
  });

test("collects work items covering open and closed issues plus map records in map order", async () => {
  const { fetchImpl, calls } = routeFetch({
    openPages: [
      [
        issue(54, {
          title: "Skills-ecosystem dashboard: build spec",
          labels: [
            { name: "workflow:ticketed" },
            { name: "ready-for-agent" },
            { name: "enhancement" },
          ],
          assignees: [{ login: "vvaz" }],
        }),
        issue(70, { labels: [{ name: "wayfinder:research" }] }),
        issue(71, {
          pull_request: { url: "https://api.github.com/repos/example/project/pulls/71" },
        }),
      ],
    ],
    maps: [
      issue(41, {
        title: "Skills-ecosystem dashboard",
        state: "closed",
        labels: [{ name: "wayfinder:map" }],
      }),
      issue(90, { labels: [{ name: "wayfinder:map" }, { name: "workflow:specced" }] }),
    ],
    subIssues: { 41: [issue(42), issue(55)], 90: [] },
    singles: {
      42: issue(42, { state: "closed", labels: [{ name: "workflow:shipped" }] }),
      55: issue(55, { state: "closed", labels: [{ name: "workflow:shipped" }] }),
    },
  });

  const { workItems, maps: mapRecords, warnings } = await collect({ fetchImpl });

  deepStrictEqual(warnings, []);
  deepStrictEqual(
    workItems.map((item) => item.id),
    ["GH-41", "GH-42", "GH-54", "GH-55", "GH-70", "GH-90"],
  );
  const spec = workItems.find((item) => item.id === "GH-54");
  strictEqual(spec.state, "open");
  strictEqual(spec.phase, "ticketed");
  strictEqual(spec.triageState, "ready-for-agent");
  strictEqual(spec.category, "enhancement");
  strictEqual(spec.kind, null);
  strictEqual(spec.deferred, false);
  deepStrictEqual(spec.assignees, ["vvaz"]);
  strictEqual(spec.url, "https://github.com/example/project/issues/54");
  match(spec.summary, /Body of issue 54/);
  const closedMember = workItems.find((item) => item.id === "GH-42");
  strictEqual(closedMember.state, "closed");
  strictEqual(closedMember.phase, "shipped");
  deepStrictEqual(mapRecords, [
    {
      mapId: "GH-41",
      title: "Skills-ecosystem dashboard",
      url: "https://github.com/example/project/issues/41",
      ticketIds: ["GH-42", "GH-55"],
    },
    {
      mapId: "GH-90",
      title: "Issue 90",
      url: "https://github.com/example/project/issues/90",
      ticketIds: [],
    },
  ]);
  const subIssueCalls = calls.filter((u) => u.pathname.endsWith("/sub_issues"));
  deepStrictEqual(
    subIssueCalls.map((u) => u.pathname),
    ["/repos/example/project/issues/41/sub_issues", "/repos/example/project/issues/90/sub_issues"],
  );
  const sweepCalls = calls.filter((u) => u.searchParams.get("state") === "open");
  ok(sweepCalls.length > 0);
  const mapQuery = calls.find((u) => u.searchParams.get("labels") === "wayfinder:map");
  strictEqual(mapQuery.searchParams.get("state"), "all");
});

test("sub-issues are membership only; an issue with children but no map label is never a map", async () => {
  const { fetchImpl, calls } = routeFetch({
    openPages: [[issue(12, { labels: [{ name: "workflow:ticketed" }] })]],
    maps: [],
    subIssues: { 12: [issue(13)] },
  });

  const { workItems, maps } = await collect({ fetchImpl });

  deepStrictEqual(maps, []);
  deepStrictEqual(
    workItems.map((item) => item.id),
    ["GH-12"],
  );
  ok(calls.every((u) => !u.pathname.endsWith("/sub_issues")));
});

test("a full page mixing issues and pull requests does not stop the sweep early (GH-136)", async () => {
  const fullPage = [
    ...Array.from({ length: 99 }, (_, index) => issue(index + 1)),
    issue(500, { pull_request: { url: "https://api.github.com/repos/example/project/pulls/500" } }),
  ];
  const { fetchImpl, calls } = routeFetch({
    openPages: [fullPage, [issue(200), issue(201), issue(202)]],
  });

  const { workItems, warnings } = await collect({ fetchImpl });

  deepStrictEqual(warnings, []);
  strictEqual(workItems.length, 102);
  ok(workItems.some((item) => item.id === "GH-202"));
  ok(!workItems.some((item) => item.id === "GH-500"));
  const sweepCalls = calls.filter(
    (u) =>
      u.searchParams.get("state") === "open" &&
      u.searchParams.get("labels") === null &&
      !u.pathname.endsWith("/pulls"),
  );
  strictEqual(sweepCalls.length, 2);
});

test("client tickets are discovered by bounded label reads and carry source metadata", async () => {
  const { fetchImpl } = routeFetch({
    openPages: [[]],
    labelPages: {
      "client-bug": [
        [
          issue(300, {
            title: "Checkout charges twice",
            labels: [{ name: "client-bug" }],
            created_at: "2026-09-01T10:00:00Z",
            updated_at: "2026-09-02T11:00:00Z",
          }),
        ],
      ],
      "client-feedback": [
        [issue(301, { labels: [{ name: "client-feedback" }, { name: "enhancement" }] })],
      ],
    },
  });

  const { workItems, clientCoverage, warnings } = await collect({ fetchImpl });

  deepStrictEqual(warnings, []);
  const bug = workItems.find((item) => item.id === "GH-300");
  strictEqual(bug.state, "open");
  deepStrictEqual(bug.labels, ["client-bug"]);
  strictEqual(bug.createdAt, "2026-09-01T10:00:00Z");
  strictEqual(bug.updatedAt, "2026-09-02T11:00:00Z");
  const feedback = workItems.find((item) => item.id === "GH-301");
  deepStrictEqual(feedback.labels, ["client-feedback", "enhancement"]);
  strictEqual(clientCoverage.complete, true);
  deepStrictEqual(clientCoverage.reasons, []);
  deepStrictEqual(clientCoverage.labels, ["client-bug", "client-feedback"]);
  match(clientCoverage.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("an issue wearing both client labels is discovered and stored once", async () => {
  const bothLabels = [{ name: "client-bug" }, { name: "client-feedback" }];
  const { fetchImpl } = routeFetch({
    labelPages: {
      "client-bug": [[issue(305, { labels: bothLabels })]],
      "client-feedback": [[issue(305, { labels: bothLabels })]],
    },
  });

  const { workItems, warnings } = await collect({ fetchImpl });

  deepStrictEqual(warnings, []);
  deepStrictEqual(workItems.filter((item) => item.id === "GH-305").length, 1);
});

test("a capped client read is unknown coverage, never zero client tickets", async () => {
  const fullClientPage = Array.from({ length: 100 }, (_, index) =>
    issue(1000 + index, { labels: [{ name: "client-bug" }] }),
  );
  const { fetchImpl } = routeFetch({
    openPages: [[]],
    labelPages: { "client-bug": [fullClientPage] },
  });

  const { clientCoverage, warnings } = await collect({ fetchImpl, maxPages: 1 });

  strictEqual(clientCoverage.complete, false);
  deepStrictEqual(clientCoverage.reasons, ["page-cap:client-bug"]);
  match(warnings.join("\n"), /client discovery/);
});

test("a failed client read degrades coverage fail-closed", async () => {
  const { fetchImpl } = routeFetch({ status: 500 });

  const { clientCoverage } = await collect({ fetchImpl });

  strictEqual(clientCoverage.complete, false);
  deepStrictEqual(clientCoverage.reasons, [
    "read-failed:client-bug",
    "read-failed:client-feedback",
  ]);
});

test("label-encoded fields derive per ADR 0007, including deferred and wayfinder kind", () => {
  const { record, warnings } = deriveWorkItem(
    issue(9, {
      labels: [
        { name: "workflow:implementing" },
        { name: "needs-info" },
        { name: "deferred" },
        { name: "bug" },
        { name: "wayfinder:prototype" },
      ],
      created_at: "2026-08-30T09:00:00Z",
      updated_at: "2026-09-01T09:00:00Z",
    }),
    DEFAULT_WORKFLOW_VOCABULARY,
  );

  deepStrictEqual(warnings, []);
  strictEqual(record.phase, "implementing");
  strictEqual(record.triageState, "needs-info");
  strictEqual(record.deferred, true);
  strictEqual(record.category, "bug");
  strictEqual(record.kind, "prototype");
  // GH-136: source labels and timestamps ride for the shared client policy.
  deepStrictEqual(record.labels, [
    "workflow:implementing",
    "needs-info",
    "deferred",
    "bug",
    "wayfinder:prototype",
  ]);
  strictEqual(record.createdAt, "2026-08-30T09:00:00Z");
  strictEqual(record.updatedAt, "2026-09-01T09:00:00Z");
});

test("an issue with no labels is pre-flow, unlabeled, and unparked", () => {
  const { record, warnings } = deriveWorkItem(
    issue(5, { body: null }),
    DEFAULT_WORKFLOW_VOCABULARY,
  );

  deepStrictEqual(warnings, []);
  strictEqual(record.phase, null);
  strictEqual(record.triageState, "unlabeled");
  strictEqual(record.deferred, false);
  strictEqual(record.category, null);
  strictEqual(record.kind, null);
  strictEqual(record.summary, "");
  strictEqual(record.state, "open");
});

test("two workflow labels resolve to the furthest-along phase with a warning", () => {
  const resolved = phaseFromLabels(
    ["workflow:specced", "workflow:implementing"],
    DEFAULT_WORKFLOW_VOCABULARY,
  );
  strictEqual(resolved.phase, "implementing");
  match(resolved.warning, /furthest-along/);
  match(resolved.warning, /workflow:specced/);
  match(resolved.warning, /workflow:implementing/);

  const farApart = phaseFromLabels(
    ["workflow:shipped", "workflow:grilling"],
    DEFAULT_WORKFLOW_VOCABULARY,
  );
  strictEqual(farApart.phase, "shipped");
});

test("an unknown workflow label is a warning and pre-flow, never a failed sync", async () => {
  const { fetchImpl } = routeFetch({
    openPages: [[issue(3, { labels: [{ name: "workflow:shiped" }] })]],
  });

  const { workItems, warnings } = await collect({ fetchImpl });

  strictEqual(workItems[0].phase, null);
  strictEqual(warnings.length, 1);
  match(warnings[0], /GH-3/);
  match(warnings[0], /workflow:shiped/);
});

test("the sweep stops at the page cap with a truncation warning", async () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  const { fetchImpl } = routeFetch({ openPages: [fullPage] });

  const { workItems, warnings } = await collect({ fetchImpl, maxPages: 1 });

  strictEqual(workItems.length, 100);
  strictEqual(warnings.length, 1);
  match(warnings[0], /cap/);
  match(warnings[0], /100/);
});

test("a failing tracker read degrades fail-closed with warnings and never fails sync", async () => {
  const { fetchImpl } = routeFetch({ status: 500 });

  const { workItems, maps, warnings } = await collect({ fetchImpl });

  deepStrictEqual(workItems, []);
  deepStrictEqual(maps, []);
  ok(warnings.length > 0);
  match(warnings.join("\n"), /HTTP 500/);
});

test("a host repo with no issues syncs to empty arrays without warnings", async () => {
  const { fetchImpl } = routeFetch({});

  const { workItems, maps, warnings } = await collect({ fetchImpl });

  deepStrictEqual(workItems, []);
  deepStrictEqual(maps, []);
  deepStrictEqual(warnings, []);
});

test("missing credentials degrade to empty arrays with a warning", async () => {
  const { fetchImpl } = routeFetch({});

  const { workItems, maps, decisions, clientCoverage, warnings } = await collect({
    fetchImpl,
    env: {},
    ghToken: async () => "",
  });

  deepStrictEqual(workItems, []);
  deepStrictEqual(maps, []);
  // The degraded shape must carry every record family the sync merge
  // iterates — the decisions collector rides the same early return (#70).
  deepStrictEqual(decisions, []);
  // Uncollected tracker state is unknown client state, never "no client
  // tickets" (GH-136).
  strictEqual(clientCoverage.complete, false);
  deepStrictEqual(clientCoverage.reasons, ["tracker-unavailable"]);
  strictEqual(warnings.length, 1);
  match(warnings[0], /GITHUB_TOKEN/);
});

test("a repository outside owner/name format degrades with a warning", async () => {
  const { fetchImpl } = routeFetch({});

  const { workItems, warnings } = await collect({ fetchImpl, repo: "banquinha" });

  deepStrictEqual(workItems, []);
  strictEqual(warnings.length, 1);
  match(warnings[0], /owner\/name/);
});

test("the workflow vocabulary parses from its markdown home in flow order", async () => {
  const text = await readFile(
    new URL("../docs/agents/workflow-labels.md", import.meta.url),
    "utf8",
  );
  const vocabulary = workflowVocabularyFromMarkdown(text);

  deepStrictEqual(
    vocabulary.map((entry) => entry.phase),
    ["grilling", "prototyping", "specced", "ticketed", "implementing", "reviewing", "shipped"],
  );
  deepStrictEqual(vocabulary[3].label, "workflow:ticketed");
});

test("vocabulary loading warns on fallback and drops non-canonical phases", async () => {
  const missing = await loadWorkflowVocabulary(join(tmpdir(), "wb-missing", "workflow-labels.md"));
  deepStrictEqual(missing.vocabulary, DEFAULT_WORKFLOW_VOCABULARY);
  strictEqual(missing.warnings.length, 1);
  match(missing.warnings[0], /unreadable/);

  const directory = await mkdtemp(join(tmpdir(), "wb-vocab-"));
  try {
    const path = join(directory, "workflow-labels.md");
    await writeFile(
      path,
      "| Phase | Label | Written by |\n| --- | --- | --- |\n| grilling | `workflow:grilling` | grill |\n| shelved | `workflow:shelved` | nobody |\n",
    );
    const loaded = await loadWorkflowVocabulary(path);
    deepStrictEqual(
      loaded.vocabulary.map((entry) => entry.phase),
      ["grilling"],
    );
    strictEqual(loaded.warnings.length, 1);
    match(loaded.warnings[0], /workflow:shelved/);
    match(loaded.warnings[0], /canonical/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a vocabulary entry outside the canonical phases never resolves", () => {
  const polluted = [
    { phase: "shelved", label: "workflow:shelved" },
    ...DEFAULT_WORKFLOW_VOCABULARY,
  ];

  const resolved = phaseFromLabels(["workflow:shelved"], polluted);
  strictEqual(resolved.phase, null);
  match(resolved.warning, /unknown workflow label/);
});

test("decision-ticket board placement parses from its markdown home", async () => {
  const text = await readFile(
    new URL("../docs/agents/workflow-labels.md", import.meta.url),
    "utf8",
  );

  deepStrictEqual(decisionPlacementFromMarkdown(text), [
    { kind: "grilling", openColumn: "grilling", closedColumn: "shipped" },
    { kind: "research", openColumn: "grilling", closedColumn: "shipped" },
    { kind: "prototype", openColumn: "prototyping", closedColumn: "shipped" },
    { kind: "task", openColumn: "ticketed", closedColumn: "shipped" },
  ]);
});

test("placement parsing reads only its own row shape, first kind wins", () => {
  const text = [
    "| Phase | Label | Written by |",
    "| --- | --- | --- |",
    "| grilling | `workflow:grilling` | grill |",
    "| Kind | Open column | Closed column |",
    "| --- | --- | --- |",
    "| `wayfinder:task` | ticketed | shipped |",
    "| `wayfinder:task` | implementing | shipped |",
    "| client bug | `client-bug` | a client reported it |",
  ].join("\n");

  deepStrictEqual(decisionPlacementFromMarkdown(text), [
    { kind: "task", openColumn: "ticketed", closedColumn: "shipped" },
  ]);
});

test("placement loading warns on fallback and drops unknown kinds and columns", async () => {
  const missing = await loadDecisionPlacement(join(tmpdir(), "wb-missing", "workflow-labels.md"));
  deepStrictEqual(missing.placement, DEFAULT_DECISION_PLACEMENT);
  strictEqual(missing.warnings.length, 1);
  match(missing.warnings[0], /unreadable/);

  const directory = await mkdtemp(join(tmpdir(), "wb-placement-"));
  try {
    const path = join(directory, "workflow-labels.md");
    await writeFile(
      path,
      [
        "| Kind | Open column | Closed column |",
        "| --- | --- | --- |",
        "| `wayfinder:grilling` | grilling | shipped |",
        "| `wayfinder:verdict` | grilling | shipped |",
        "| `wayfinder:task` | shelved | shipped |",
        "| `wayfinder:map` | grilling | shipped |",
      ].join("\n"),
    );
    const loaded = await loadDecisionPlacement(path);
    deepStrictEqual(loaded.placement, [
      { kind: "grilling", openColumn: "grilling", closedColumn: "shipped" },
    ]);
    strictEqual(loaded.warnings.length, 3);
    match(loaded.warnings[0], /wayfinder:verdict/);
    match(loaded.warnings[1], /wayfinder:task/);
    match(loaded.warnings[1], /canonical/);
    match(loaded.warnings[2], /wayfinder:map/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("targeted-read caps warn per map and membership stays complete", async () => {
  const members = Array.from({ length: 251 }, (_, index) => issue(index + 200));
  const { fetchImpl } = routeFetch({
    openPages: [[]],
    maps: [issue(100, { labels: [{ name: "wayfinder:map" }] })],
    subIssues: { 100: members },
  });

  const { workItems, maps, warnings } = await collect({ fetchImpl });

  strictEqual(workItems.length, 1);
  strictEqual(maps[0].ticketIds.length, 251);
  match(
    warnings.join("\n"),
    /GH-100: targeted reads stopped at the 250 cap; 1 member records not collected/,
  );
});

test("the shipped page is a bounded newest-first label query, deduped against held records", async () => {
  const { fetchImpl, calls } = routeFetch({
    openPages: [[issue(54, { labels: [{ name: "workflow:ticketed" }] })]],
    labelPages: {
      "workflow:shipped": [
        [
          issue(55, { state: "closed", labels: [{ name: "workflow:shipped" }] }),
          issue(65, { state: "closed", labels: [{ name: "workflow:shipped" }] }),
          // Already held by the open sweep: the board merges, never duplicates.
          issue(54, { state: "closed", labels: [{ name: "workflow:shipped" }] }),
        ],
      ],
    },
  });

  const { recentlyShipped, warnings } = await collect({ fetchImpl });

  deepStrictEqual(warnings, []);
  deepStrictEqual(
    recentlyShipped.map((item) => item.id),
    ["GH-65", "GH-55"],
  );
  deepStrictEqual(
    recentlyShipped.map((item) => item.phase),
    ["shipped", "shipped"],
  );
  const shippedCall = calls.find((call) => call.searchParams.get("labels") === "workflow:shipped");
  ok(shippedCall);
  strictEqual(shippedCall.searchParams.get("state"), "closed");
  strictEqual(shippedCall.searchParams.get("sort"), "updated");
  strictEqual(shippedCall.searchParams.get("direction"), "desc");
  strictEqual(shippedCall.searchParams.get("per_page"), "100");
  strictEqual(shippedCall.searchParams.get("page"), "1");
});

test("the shipped page stops at one page with a truncation warning", async () => {
  const fullPage = Array.from({ length: 100 }, (_, index) =>
    issue(2000 + index, { state: "closed", labels: [{ name: "workflow:shipped" }] }),
  );
  const { fetchImpl } = routeFetch({
    openPages: [[]],
    labelPages: { "workflow:shipped": [fullPage] },
  });

  const { recentlyShipped, warnings } = await collect({ fetchImpl, maxPages: 1 });

  strictEqual(recentlyShipped.length, 100);
  match(warnings.join("\n"), /closed "workflow:shipped" issues stopped at the 1-page cap/);
});

test("a failed shipped read degrades to an empty page with a warning, never a failed sync", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.searchParams.get("labels") === "workflow:shipped")
      return { ok: false, status: 500, json: async () => ({ message: "boom" }) };
    if (u.searchParams.get("labels") === "wayfinder:map") return jsonResponse([]);
    if (u.searchParams.get("labels")) return jsonResponse([]);
    if (u.pathname.endsWith("/pulls")) return jsonResponse([]);
    return jsonResponse([]);
  };

  const { recentlyShipped, warnings } = await collect({ fetchImpl });

  deepStrictEqual(recentlyShipped, []);
  match(warnings.join("\n"), /closed "workflow:shipped" issues unavailable/);
});

test("the parsed decision-placement table rides the tracker state", async () => {
  const { fetchImpl } = routeFetch({ openPages: [[]] });

  const { decisionPlacement } = await collect({ fetchImpl });

  deepStrictEqual(decisionPlacement, DEFAULT_DECISION_PLACEMENT);
});
