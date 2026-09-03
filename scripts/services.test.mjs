import { deepStrictEqual, match, rejects, strictEqual } from "node:assert";
import test from "node:test";

import { fetchAsana } from "./services/asana.mjs";
import { fetchGitHub } from "./services/github.mjs";
import { fetchGitLab } from "./services/gitlab.mjs";
import { fetchNotion } from "./services/notion.mjs";
import { fetchConfiguredServices } from "./services/index.mjs";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("fetches and normalizes paginated Asana project tasks", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return calls.length === 1
      ? jsonResponse({
          data: [
            {
              gid: "1",
              name: "Prepare launch",
              completed: false,
              notes: "Confirm the release checklist.",
              memberships: [{ section: { name: "Ready" } }],
              due_on: "2026-09-10",
              assignee: { name: "Ada" },
              permalink_url: "https://app.asana.com/0/project/1",
            },
          ],
          next_page: { offset: "next-page" },
        })
      : jsonResponse({
          data: [
            {
              gid: "2",
              name: "Ship launch",
              completed: true,
              notes: "",
              permalink_url: "https://app.asana.com/0/project/2",
            },
          ],
          next_page: null,
        });
  };

  const result = await fetchAsana(
    {
      id: "roadmap",
      type: "asana",
      projectGid: "project-1",
      statusMap: { Ready: "ready-for-agent" },
    },
    { env: { ASANA_TOKEN: "secret" }, fetchImpl },
  );

  strictEqual(result.records.length, 2);
  strictEqual(result.records[0].id, "ASANA-1");
  strictEqual(result.records[0].status, "ready");
  strictEqual(result.records[0].statusLabel, "ready-for-agent");
  strictEqual(result.records[0].lane, "Ready");
  strictEqual(result.records[1].status, "complete");
  strictEqual(calls[0].url.searchParams.get("limit"), "100");
  strictEqual(calls[1].url.searchParams.get("offset"), "next-page");
  strictEqual(calls[0].options.headers.Authorization, "Bearer secret");
  match(calls[0].options.headers.Accept, /application\/json/);
});

test("fetches and maps Notion data-source pages using configured properties", async () => {
  let call;
  const fetchImpl = async (url, options) => {
    call = { url, options };
    return jsonResponse({
      results: [
        {
          id: "1111-2222",
          url: "https://www.notion.so/task",
          properties: {
            Name: {
              type: "title",
              title: [{ plain_text: "Write docs" }],
            },
            Status: {
              type: "status",
              status: { name: "In progress" },
            },
            Project: {
              type: "select",
              select: { name: "Workbench" },
            },
            Area: {
              type: "rich_text",
              rich_text: [{ plain_text: "Docs" }],
            },
            "Ticket ID": {
              type: "rich_text",
              rich_text: [{ plain_text: "DOC-001" }],
            },
            Description: {
              type: "rich_text",
              rich_text: [{ plain_text: "Document the setup." }],
            },
          },
        },
      ],
      next_cursor: null,
      has_more: false,
    });
  };

  const result = await fetchNotion(
    {
      id: "notion-work",
      type: "notion",
      dataSourceId: "data-source-1",
      properties: {
        title: "Name",
        status: "Status",
        group: "Project",
        lane: "Area",
        id: "Ticket ID",
        summary: "Description",
      },
    },
    { env: { NOTION_TOKEN: "secret" }, fetchImpl },
  );

  strictEqual(result.records.length, 1);
  strictEqual(result.records[0].id, "DOC-001");
  strictEqual(result.records[0].status, "in-progress");
  strictEqual(result.records[0].group, "Workbench");
  strictEqual(result.records[0].lane, "Docs");
  strictEqual(result.records[0].summary, "Document the setup.");
  strictEqual(call.options.headers.Authorization, "Bearer secret");
  strictEqual(call.options.headers["Notion-Version"], "2026-03-11");
  deepStrictEqual(JSON.parse(call.options.body), {
    page_size: 100,
    result_type: "page",
  });
});

test("fetches and maps paginated GitHub issues, ignoring pull requests", async () => {
  const calls = [];
  const openIssue = (number, overrides = {}) => ({
    number,
    title: `Issue ${number}`,
    state: "open",
    labels: [],
    body: "",
    html_url: `https://github.com/example/project/issues/${number}`,
    ...overrides,
  });
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    index === 0
      ? openIssue(12, {
          title: "Add GitLab adapter",
          labels: [{ name: "ready-for-agent" }, { name: "backend" }],
          body: "Implement the adapter.",
          assignee: { login: "ada" },
          milestone: { title: "v0.2" },
        })
      : index === 1
        ? openIssue(13, {
            title: "A pull request",
            pull_request: { url: "https://api.github.com/repos/example/project/pulls/13" },
          })
        : openIssue(index + 1),
  );
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return calls.length === 1
      ? jsonResponse(firstPage)
      : jsonResponse([
          openIssue(7, {
            title: "Rejected approach",
            state: "closed",
            state_reason: "not_planned",
            labels: ["wontfix"],
          }),
        ]);
  };

  const result = await fetchGitHub(
    { id: "issues", type: "github", repo: "example/project" },
    { env: { GITHUB_TOKEN: "secret" }, fetchImpl },
  );

  strictEqual(result.records.length, 100);
  strictEqual(result.records[0].id, "GH-12");
  strictEqual(result.records[0].status, "ready");
  strictEqual(result.records[0].statusLabel, "ready-for-agent");
  strictEqual(result.records[0].lane, "ready-for-agent");
  strictEqual(result.records[0].statusDetail, "v0.2 · Assigned to ada");
  strictEqual(result.records[0].summary, "Implement the adapter.");
  strictEqual(result.records[0].sourceUrl, "https://github.com/example/project/issues/12");
  strictEqual(result.records[99].id, "GH-7");
  strictEqual(result.records[99].status, "complete");
  strictEqual(result.records[99].statusLabel, "wontfix");
  strictEqual(calls.length, 2);
  strictEqual(calls[0].url.pathname, "/repos/example/project/issues");
  strictEqual(calls[0].url.searchParams.get("state"), "open");
  strictEqual(calls[0].url.searchParams.get("page"), "1");
  strictEqual(calls[1].url.searchParams.get("page"), "2");
  strictEqual(calls[0].options.headers.Authorization, "Bearer secret");
  strictEqual(calls[0].options.headers.Accept, "application/vnd.github+json");
  strictEqual(result.message, "100 issues loaded");
});

test("falls back to the gh CLI token when the token env var is unset", async () => {
  let call;
  const fetchImpl = async (url, options) => {
    call = { url, options };
    return jsonResponse([]);
  };

  const result = await fetchGitHub(
    { id: "issues", type: "github", repo: "example/project" },
    { env: {}, fetchImpl, ghToken: async () => "cli-token" },
  );

  strictEqual(result.records.length, 0);
  strictEqual(call.options.headers.Authorization, "Bearer cli-token");
  strictEqual(result.message, "0 issues loaded");
});

test("prefers the token env var over the gh CLI", async () => {
  let call;
  const fetchImpl = async (url, options) => {
    call = { url, options };
    return jsonResponse([]);
  };

  await fetchGitHub(
    { id: "issues", type: "github", repo: "example/project", tokenEnv: "GH_TOKEN" },
    { env: { GH_TOKEN: "env-token" }, fetchImpl, ghToken: async () => "cli-token" },
  );

  strictEqual(call.options.headers.Authorization, "Bearer env-token");
});

test("reports missing GitHub credentials when env var and gh CLI are both unavailable", async () => {
  await rejects(
    fetchGitHub(
      { id: "issues", type: "github", repo: "example/project" },
      { env: {}, fetchImpl: async () => jsonResponse([]), ghToken: async () => "" },
    ),
    /missing GITHUB_TOKEN/,
  );
});

test("fetches and maps GitLab project issues by project path", async () => {
  let call;
  const fetchImpl = async (url, options) => {
    call = { url: new URL(url), options };
    return jsonResponse([
      {
        iid: 41,
        title: "Wire GitLab issues",
        state: "opened",
        labels: ["in-progress", "backend"],
        description: "Read issues from GitLab.",
        web_url: "https://gitlab.com/example/project/-/issues/41",
        milestone: { title: "v0.2" },
        due_date: "2026-09-15",
        assignees: [{ username: "grace", name: "Grace Hopper" }],
      },
    ]);
  };

  const result = await fetchGitLab(
    { id: "gitlab", type: "gitlab", projectPath: "example/project" },
    { env: { GITLAB_TOKEN: "secret" }, fetchImpl },
  );

  strictEqual(result.records.length, 1);
  strictEqual(result.records[0].id, "GL-41");
  strictEqual(result.records[0].status, "in-progress");
  strictEqual(result.records[0].statusLabel, "in-progress");
  strictEqual(result.records[0].statusDetail, "v0.2 · Due 2026-09-15 · Assigned to Grace Hopper");
  strictEqual(result.records[0].lane, "in-progress");
  strictEqual(result.records[0].sourceUrl, "https://gitlab.com/example/project/-/issues/41");
  strictEqual(call.url.pathname, "/api/v4/projects/example%2Fproject/issues");
  strictEqual(call.url.searchParams.get("state"), "opened");
  strictEqual(call.options.headers["PRIVATE-TOKEN"], "secret");
  strictEqual(result.message, "1 issues loaded");
});

test("supports numeric GitLab project IDs and self-hosted API base URLs", async () => {
  let url;
  const fetchImpl = async (candidate) => {
    url = new URL(candidate);
    return jsonResponse([]);
  };

  const result = await fetchGitLab(
    {
      id: "self-hosted",
      type: "gitlab",
      projectId: 12345,
      apiBaseUrl: "https://gitlab.example.com/api/v4",
    },
    { env: { GITLAB_TOKEN: "secret" }, fetchImpl },
  );

  strictEqual(result.records.length, 0);
  strictEqual(url.host, "gitlab.example.com");
  strictEqual(decodeURIComponent(url.pathname), "/api/v4/projects/12345/issues");
  strictEqual(result.message, "0 issues loaded");
});

test("reports missing credentials without aborting the snapshot", async () => {
  let called = false;
  const result = await fetchConfiguredServices(
    [
      {
        id: "roadmap",
        type: "asana",
        projectGid: "project-1",
      },
    ],
    {
      env: {},
      fetchImpl: async () => {
        called = true;
        return jsonResponse({ data: [] });
      },
    },
  );

  strictEqual(called, false);
  deepStrictEqual(result.records, []);
  strictEqual(result.statuses[0].status, "error");
  strictEqual(result.statuses[0].message, "missing ASANA_TOKEN");
});
