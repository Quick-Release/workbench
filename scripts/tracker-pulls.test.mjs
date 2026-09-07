import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { DEFAULT_WORKFLOW_VOCABULARY } from "./tracker/labels.mjs";
import { collectTrackerState } from "./tracker/index.mjs";
import { fetchOpenPullRequests } from "./tracker/pulls.mjs";

// The pull-request record family, collected over recorded GitHub REST
// fixtures — the same paged, capped, fail-soft read shapes the issue
// families use, never a live call in tests.

const pull = (number, overrides = {}) => ({
  number,
  title: `Pull request ${number}`,
  state: "open",
  draft: false,
  html_url: `https://github.com/example/project/pull/${number}`,
  body: `Body of pull request ${number}.`,
  user: { login: "someone" },
  head: { ref: "feature/one" },
  base: { ref: "main" },
  ...overrides,
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const pullsFetch = ({ pages = [[]], status = 200 } = {}) => {
  const calls = [];
  let page = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const payload = pages[Math.min(page, pages.length - 1)];
    page += 1;
    return jsonResponse(payload, status);
  };
  return { fetchImpl, calls };
};

const PER_PAGE_100 = Array.from({ length: 100 }, (_, index) => pull(index + 1));

test("reads open pull requests into the flattened record shape", async () => {
  const { fetchImpl, calls } = pullsFetch({
    pages: [[pull(80, { title: "Version Packages", head: { ref: "changeset-release/main" } })]],
  });
  const { pulls, warnings } = await fetchOpenPullRequests({
    repo: "example/project",
    token: "secret",
    apiBase: "https://api.github.com",
    fetchImpl,
    maxPages: 10,
  });
  deepStrictEqual(pulls, [
    {
      number: 80,
      title: "Version Packages",
      url: "https://github.com/example/project/pull/80",
      head: "changeset-release/main",
      base: "main",
      author: "someone",
      isDraft: false,
      body: "Body of pull request 80.",
    },
  ]);
  deepStrictEqual(warnings, []);
  strictEqual(calls[0].pathname.endsWith("/pulls"), true);
  strictEqual(calls[0].searchParams.get("state"), "open");
});

test("pages under the cap and stops at a short page", async () => {
  const { fetchImpl } = pullsFetch({ pages: [PER_PAGE_100, [pull(101)], []] });
  const { pulls, warnings } = await fetchOpenPullRequests({
    repo: "example/project",
    token: "secret",
    apiBase: "https://api.github.com",
    fetchImpl,
    maxPages: 10,
  });
  strictEqual(pulls.length, 101);
  deepStrictEqual(warnings, []);
});

test("stops at the page cap with a truncation warning", async () => {
  const { fetchImpl } = pullsFetch({ pages: [PER_PAGE_100, PER_PAGE_100] });
  const { pulls, warnings } = await fetchOpenPullRequests({
    repo: "example/project",
    token: "secret",
    apiBase: "https://api.github.com",
    fetchImpl,
    maxPages: 2,
  });
  strictEqual(pulls.length, 200);
  strictEqual(warnings.length, 1);
  strictEqual(warnings[0].includes("cap"), true);
});

test("a failed read degrades fail-soft with a warning, never a thrown sync", async () => {
  const { fetchImpl } = pullsFetch({ status: 500 });
  const { pulls, warnings } = await fetchOpenPullRequests({
    repo: "example/project",
    token: "secret",
    apiBase: "https://api.github.com",
    fetchImpl,
    maxPages: 10,
  });
  deepStrictEqual(pulls, []);
  strictEqual(warnings.length, 1);
  strictEqual(warnings[0].includes("open pull requests"), true);
});

const collect = (overrides = {}) =>
  collectTrackerState({
    repo: "example/project",
    env: { GITHUB_TOKEN: "secret" },
    ghToken: async () => "",
    vocabulary: DEFAULT_WORKFLOW_VOCABULARY,
    ...overrides,
  });

const trackerFetch = ({ openPages = [[]], pulls = [] } = {}) => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get("labels") === "wayfinder:map") return jsonResponse([]);
    if (u.pathname.endsWith("/pulls")) return jsonResponse(pulls);
    return jsonResponse(openPages, 200);
  };
  return { fetchImpl };
};

test("pull-request records ride the tracker state beside the issue families", async () => {
  const { fetchImpl } = trackerFetch({ pulls: [pull(80)] });
  const state = await collect({ fetchImpl });
  deepStrictEqual(state.pullRequests, [
    {
      number: 80,
      title: "Pull request 80",
      url: "https://github.com/example/project/pull/80",
      head: "feature/one",
      base: "main",
      author: "someone",
      isDraft: false,
      body: "Body of pull request 80.",
    },
  ]);
});

test("every degraded tracker return still carries the pulls array", async () => {
  for (const degraded of [
    await collect({ repo: "not-a-repo" }),
    await collect({ env: {}, ghToken: async () => "" }),
    await collect({ fetchImpl: trackerFetch({}).fetchImpl }),
  ]) {
    strictEqual(Array.isArray(degraded.pullRequests), true);
    deepStrictEqual(degraded.pullRequests, []);
  }
});
