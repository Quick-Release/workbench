import { deepStrictEqual, match, ok, strictEqual } from "node:assert";
import test from "node:test";

import {
  blockedByRefs,
  lineEdgesForBody,
  lineEdgesForTicketFile,
  mergeBlockerEdges,
} from "./tracker/edges.mjs";
import { collectTrackerState } from "./tracker/index.mjs";
import { DEFAULT_WORKFLOW_VOCABULARY } from "./tracker/labels.mjs";

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

// Routes the tracker's read shapes, including the native blocked-by lists.
const routeFetch = ({
  openPages = [[]],
  maps = [],
  subIssues = {},
  singles = {},
  blockedBy = {},
  blockedByStatus = 200,
  status = 200,
} = {}) => {
  const calls = [];
  let sweepPage = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith("/dependencies/blocked_by")) {
      const number = u.pathname.match(/\/issues\/(\d+)\/dependencies\/blocked_by$/)[1];
      return jsonResponse(blockedBy[number] ?? [], blockedByStatus);
    }
    if (u.searchParams.get("labels") === "wayfinder:map") return jsonResponse(maps, status);
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

test("the three key aliases of the line grammar name the same edge", () => {
  for (const alias of ["Blocked by", "Depends on", "Dependencies"]) {
    deepStrictEqual(blockedByRefs(`${alias}: #55`, "GH"), ["GH-55"]);
  }
  deepStrictEqual(
    mergeBlockerEdges({
      nativeAvailable: false,
      lineEdges: [
        ...lineEdgesForBody("Blocked by: #55", "GH-56", "https://example/issues/56"),
        ...lineEdgesForBody("Depends on: #55", "GH-56", "https://example/issues/56"),
      ],
      knownIds: new Set(["GH-55", "GH-56"]),
    }).edges,
    [
      {
        blockedId: "GH-56",
        blockerId: "GH-55",
        source: "blocked-by-line",
        sourceRef: "https://example/issues/56",
      },
    ],
  );
});

test("body lines resolve unqualified refs in the issue's home namespace and qualified refs across sources", () => {
  deepStrictEqual(blockedByRefs("Blocked by: #55, 56", "GH"), ["GH-55", "GH-56"]);
  deepStrictEqual(blockedByRefs("blocked by: BQ-12", "GH"), ["BQ-12"]);
  deepStrictEqual(blockedByRefs("- Depends on: GH-47", "GH"), ["GH-47"]);
  deepStrictEqual(blockedByRefs("Blocked by: #55 and #56 then prose", "GH"), ["GH-55"]);
  deepStrictEqual(blockedByRefs("No blockers here.", "GH"), []);
  deepStrictEqual(
    lineEdgesForBody("Blocked by: #55", "GH-56", "https://github.com/example/project/issues/56"),
    [
      {
        blockedId: "GH-56",
        blockerId: "GH-55",
        source: "blocked-by-line",
        sourceRef: "https://github.com/example/project/issues/56",
      },
    ],
  );
});

test("a local ticket file resolves unqualified refs in its own namespace first", () => {
  deepStrictEqual(
    lineEdgesForTicketFile({
      id: "BQ-12",
      text: "# BQ-12 — Title\n\nBlocked by: #8\nDepends on: GH-47\n",
      sourcePath: "docs/plans/dashboard/tickets/BQ-12.md",
    }),
    [
      {
        blockedId: "BQ-12",
        blockerId: "BQ-8",
        source: "blocked-by-line",
        sourceRef: "docs/plans/dashboard/tickets/BQ-12.md",
      },
      {
        blockedId: "BQ-12",
        blockerId: "GH-47",
        source: "blocked-by-line",
        sourceRef: "docs/plans/dashboard/tickets/BQ-12.md",
      },
    ],
  );
});

test("native wins at the repo level: same-namespace lines are ignored, cross-source lines survive", () => {
  const native = [
    {
      blockedId: "GH-56",
      blockerId: "GH-55",
      source: "github-native",
      sourceRef: "https://github.com/example/project/issues/56",
    },
  ];
  const lines = [
    {
      blockedId: "GH-56",
      blockerId: "GH-55",
      source: "blocked-by-line",
      sourceRef: "https://github.com/example/project/issues/56",
    },
    {
      blockedId: "GH-56",
      blockerId: "BQ-12",
      source: "blocked-by-line",
      sourceRef: "https://github.com/example/project/issues/56",
    },
  ];

  const merged = mergeBlockerEdges({
    nativeEdges: native,
    nativeAvailable: true,
    lineEdges: lines,
    knownIds: new Set(["GH-55", "GH-56", "BQ-12"]),
  });
  // Sorted deterministically: the surviving cross-source line sorts before
  // the native edge on blocker-number order.
  deepStrictEqual(merged.edges, [lines[1], native[0]]);
  deepStrictEqual(merged.warnings, []);

  const fallback = mergeBlockerEdges({
    nativeEdges: [],
    nativeAvailable: false,
    lineEdges: lines,
    knownIds: new Set(["GH-55", "GH-56", "BQ-12"]),
  });
  deepStrictEqual(fallback.edges, [lines[1], lines[0]]);
});

test("hygiene: self-edges drop with a warning, dangling edges stay fail-closed, cycles surface without breaking", () => {
  const selfEdge = lineEdgesForBody("Blocked by: #55", "GH-55", "https://example/issues/55")[0];
  const dangling = lineEdgesForBody("Blocked by: #999", "GH-56", "https://example/issues/56")[0];
  const forward = lineEdgesForBody("Blocked by: #56", "GH-57", "https://example/issues/57")[0];
  const back = lineEdgesForBody("Blocked by: #57", "GH-56", "https://example/issues/56")[0];

  const { edges, warnings } = mergeBlockerEdges({
    nativeEdges: [],
    nativeAvailable: false,
    lineEdges: [selfEdge, dangling, forward, back],
    knownIds: new Set(["GH-55", "GH-56", "GH-57"]),
  });

  deepStrictEqual(edges, [back, dangling, forward]);
  const joined = warnings.join("\n");
  match(joined, /GH-55.*itself|itself.*GH-55/);
  match(joined, /GH-999/);
  match(joined, /dangling|unknown/i);
  match(joined, /cycle/i);
  match(joined, /GH-56/);
  match(joined, /GH-57/);
});

test("this repo's native blocked-by edges collect with provenance and targeted reads for closed blockers", async () => {
  const { fetchImpl, calls } = routeFetch({
    openPages: [
      [
        issue(56, {
          body: "Stale line: Blocked by: #55 — superseded by the native edge.",
          issue_dependencies_summary: { blocked_by: 1, total_blocked_by: 2 },
        }),
        issue(57, { issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 0 } }),
      ],
    ],
    blockedBy: { 56: [issue(55, { state: "closed" }), issue(57, { state: "open" })] },
    singles: { 55: issue(55, { state: "closed" }) },
  });

  const { workItems, blockerEdges, warnings } = await collect({ fetchImpl });

  deepStrictEqual(warnings, []);
  deepStrictEqual(blockerEdges, [
    {
      blockedId: "GH-56",
      blockerId: "GH-55",
      source: "github-native",
      sourceRef: "https://github.com/example/project/issues/56",
    },
    {
      blockedId: "GH-56",
      blockerId: "GH-57",
      source: "github-native",
      sourceRef: "https://github.com/example/project/issues/56",
    },
  ]);
  ok(workItems.some((item) => item.id === "GH-55" && item.state === "closed"));
  ok(calls.some((u) => u.pathname === "/repos/example/project/issues/56/dependencies/blocked_by"));
  // The closed blocker's record came from one targeted read, and the stale
  // same-namespace line did not resurrect a second edge.
  deepStrictEqual(
    calls
      .filter((u) => /^\/repos\/example\/project\/issues\/\d+$/.test(u.pathname))
      .map((u) => u.pathname),
    ["/repos/example/project/issues/55"],
  );
});

test("where the dependencies feature is silent, `Blocked by:` lines are the sole edge source", async () => {
  const { fetchImpl } = routeFetch({
    openPages: [
      [
        issue(55),
        issue(56, { body: "Blocked by: #55\n" }),
        issue(57, { body: "Blocked by: #900\n" }),
      ],
    ],
  });

  const { blockerEdges, warnings } = await collect({ fetchImpl });

  deepStrictEqual(blockerEdges, [
    {
      blockedId: "GH-56",
      blockerId: "GH-55",
      source: "blocked-by-line",
      sourceRef: "https://github.com/example/project/issues/56",
    },
    {
      blockedId: "GH-57",
      blockerId: "GH-900",
      source: "blocked-by-line",
      sourceRef: "https://github.com/example/project/issues/57",
    },
  ]);
  const joined = warnings.join("\n");
  match(joined, /GH-900/);
  match(joined, /dangling|unknown/i);
});

test("a failing blocked-by read degrades with a warning and never fails sync", async () => {
  const { fetchImpl } = routeFetch({
    openPages: [
      [issue(56, { issue_dependencies_summary: { blocked_by: 2, total_blocked_by: 2 } })],
    ],
    blockedByStatus: 500,
  });

  const { blockerEdges, warnings } = await collect({ fetchImpl });

  deepStrictEqual(blockerEdges, []);
  strictEqual(warnings.length, 1);
  match(warnings[0], /GH-56/);
  match(warnings[0], /HTTP 500/);
});

test("a repo with no dependency summaries and no body lines collects no edges and no warnings", async () => {
  const { fetchImpl } = routeFetch({ openPages: [[issue(1), issue(2)]] });

  const { blockerEdges, warnings } = await collect({ fetchImpl });

  deepStrictEqual(blockerEdges, []);
  deepStrictEqual(warnings, []);
});
