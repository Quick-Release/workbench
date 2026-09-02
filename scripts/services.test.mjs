import { deepStrictEqual, match, strictEqual } from "node:assert";
import test from "node:test";

import { fetchAsana } from "./services/asana.mjs";
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
