import { mkdtemp, readFile, rm } from "node:fs/promises";
import { deepStrictEqual, strictEqual } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { handleToolsApi, isToolsApiRoute } from "./tools-api.mjs";

const loopback = { host: "localhost:4051", origin: "http://localhost:4051" };
const rootDirectory = "/host/repo";
const status = {
  tools: [
    { id: "fallow", configured: false },
    { id: "renovate", configured: true },
  ],
};

const dependencies = (overrides = {}) => ({
  rootDirectory,
  getStatus: async () => status,
  setupTool: async () => "Setup complete.",
  ...loopback,
  ...overrides,
});

test("recognizes tool status and setup routes only", () => {
  strictEqual(isToolsApiRoute("/api/tools"), true);
  strictEqual(isToolsApiRoute("/api/tools/renovate/setup"), true);
  strictEqual(isToolsApiRoute("/api/skills"), false);
  strictEqual(isToolsApiRoute("/api/tools/unknown/path"), false);
});

test("returns tool status for a loopback GET", async () => {
  const handled = await handleToolsApi({
    method: "GET",
    pathname: "/api/tools",
    ...dependencies(),
  });

  deepStrictEqual(handled, { status: 200, json: status });
});

test("rejects a foreign host before reading tool status or running setup", async () => {
  let statusReads = 0;
  let setups = 0;
  const handled = await handleToolsApi({
    method: "POST",
    pathname: "/api/tools/fallow/setup",
    ...dependencies({
      host: "host-repo.example:4051",
      getStatus: async () => {
        statusReads += 1;
        return status;
      },
      setupTool: async () => {
        setups += 1;
        return "should not run";
      },
    }),
  });

  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "forbidden_host");
  strictEqual(statusReads, 0);
  strictEqual(setups, 0);
});

test("rejects a cross-origin setup request", async () => {
  const handled = await handleToolsApi({
    method: "POST",
    pathname: "/api/tools/fallow/setup",
    ...dependencies({ origin: "http://evil.example:4051" }),
  });

  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "cross_origin");
});

test("runs a known setup and returns the refreshed status", async () => {
  const calls = [];
  const handled = await handleToolsApi({
    method: "POST",
    pathname: "/api/tools/fallow/setup",
    ...dependencies({
      getStatus: async (directory) => {
        calls.push({ kind: "status", directory });
        return status;
      },
      setupTool: async (directory, id) => {
        calls.push({ kind: "setup", directory, id });
        return "Added fallow.";
      },
    }),
  });

  strictEqual(handled.status, 200);
  deepStrictEqual(handled.json, { message: "Added fallow.", ...status });
  deepStrictEqual(calls, [
    { kind: "setup", directory: rootDirectory, id: "fallow" },
    { kind: "status", directory: rootDirectory },
  ]);
});

test("rejects an unknown tool without running setup", async () => {
  let setups = 0;
  const handled = await handleToolsApi({
    method: "POST",
    pathname: "/api/tools/constructor/setup",
    ...dependencies({
      setupTool: async () => {
        setups += 1;
        return "should not run";
      },
    }),
  });

  strictEqual(handled.status, 404);
  deepStrictEqual(handled.json, { message: "Unknown tool: constructor" });
  strictEqual(setups, 0);
});

test("answers method mismatches without touching the host repo", async () => {
  let statusReads = 0;
  const handled = await handleToolsApi({
    method: "POST",
    pathname: "/api/tools",
    ...dependencies({
      getStatus: async () => {
        statusReads += 1;
        return status;
      },
    }),
  });

  strictEqual(handled.status, 405);
  strictEqual(handled.json.error, "method_not_allowed");
  strictEqual(statusReads, 0);
});

test("turns setup failures into an API error", async () => {
  const handled = await handleToolsApi({
    method: "POST",
    pathname: "/api/tools/renovate/setup",
    ...dependencies({
      setupTool: async () => {
        throw new Error("permission denied");
      },
    }),
  });

  strictEqual(handled.status, 500);
  deepStrictEqual(handled.json, { message: "permission denied" });
});

test("the renovate setup writes its config and reports it as configured", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "workbench-tools-"));
  try {
    const handled = await handleToolsApi({
      method: "POST",
      pathname: "/api/tools/renovate/setup",
      rootDirectory,
      ...loopback,
    });

    strictEqual(handled.status, 200);
    strictEqual(handled.json.tools.find((tool) => tool.id === "renovate").configured, true);
    const config = JSON.parse(await readFile(join(rootDirectory, "renovate.json"), "utf8"));
    deepStrictEqual(config.extends, ["config:recommended", "schedule:weekly"]);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
