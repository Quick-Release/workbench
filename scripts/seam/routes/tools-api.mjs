import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { guardedApi, methodMismatch, sendJson } from "../middleware/api-shared.mjs";
import { gateRejection } from "../middleware/request-gate.mjs";

const execFileAsync = promisify(execFile);

// The workbench always runs through the Vite dev server (`pnpm dev` / the
// `workbench` bin), so a dev-server middleware is the only backend the tools
// page needs. Everything is scoped to the repo root the server runs in.
const RENOVATE_CONFIG = `${JSON.stringify(
  {
    $schema: "https://docs.renovatebot.com/renovate-schema.json",
    extends: ["config:recommended", "schedule:weekly"],
    rangeStrategy: "bump",
    packageRules: [
      {
        description: "Group Effect RC and alchemy beta pins so they move together",
        matchPackagePatterns: ["^effect$", "^@effect/", "^alchemy$"],
        groupName: "effect-and-alchemy",
      },
    ],
  },
  null,
  2,
)}\n`;

const fileExists = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const toolsStatus = async (rootDirectory) => {
  const packageJson = await readJson(join(rootDirectory, "package.json")).catch(() => ({}));
  return {
    tools: [
      {
        id: "fallow",
        configured: Boolean(packageJson.devDependencies?.fallow),
      },
      {
        id: "renovate",
        configured: await fileExists(join(rootDirectory, "renovate.json")),
      },
    ],
  };
};

const setups = {
  // Fallow needs no config file to start — the setup is just the devDependency.
  fallow: async (rootDirectory) => {
    await execFileAsync("pnpm", ["add", "-D", "fallow"], {
      cwd: rootDirectory,
      encoding: "utf8",
    });
    return "Added fallow as a devDependency. Try `pnpm exec fallow audit`.";
  },
  renovate: async (rootDirectory) => {
    const configPath = join(rootDirectory, "renovate.json");
    if (await fileExists(configPath)) return "renovate.json already exists.";
    await writeFile(configPath, RENOVATE_CONFIG);
    return "Created renovate.json. Install the Renovate GitHub App on the repo to activate it.";
  },
};

const runToolSetup = async (rootDirectory, id) => setups[id](rootDirectory);

const TOOL_STATUS_ROUTE = /^\/api\/tools\/?$/;
const TOOL_SETUP_ROUTE = /^\/api\/tools\/([\w-]+)\/setup$/;

export const isToolsApiRoute = (pathname) =>
  TOOL_STATUS_ROUTE.test(pathname) || TOOL_SETUP_ROUTE.test(pathname);

const errorMessage = (error, fallback) =>
  String(error?.stderr ?? error?.message ?? error ?? fallback);

// The tools execution seam is kept pure at the HTTP boundary: host-repo
// status and side effects are injected, while the shared gate and response
// contract remain exercised by route tests.
export const handleToolsApi = async ({
  method,
  pathname,
  host,
  origin,
  rootDirectory,
  getStatus = toolsStatus,
  setupTool = runToolSetup,
}) => {
  if (!isToolsApiRoute(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (TOOL_STATUS_ROUTE.test(pathname)) {
    if (method !== "GET") return methodMismatch("GET");
    try {
      return { status: 200, json: await getStatus(rootDirectory) };
    } catch (error) {
      return { status: 500, json: { message: errorMessage(error, "Unable to read tool status.") } };
    }
  }

  if (method !== "POST") return methodMismatch("POST");

  const id = TOOL_SETUP_ROUTE.exec(pathname)?.[1];
  if (!id || !Object.hasOwn(setups, id))
    return { status: 404, json: { message: `Unknown tool: ${id}` } };

  try {
    const message = await setupTool(rootDirectory, id);
    return {
      status: 200,
      json: { message, ...(await getStatus(rootDirectory)) },
    };
  } catch (error) {
    return { status: 500, json: { message: errorMessage(error, "Setup failed.") } };
  }
};

export const toolsApiPlugin = ({ getStatus = toolsStatus, setupTool = runToolSetup } = {}) => ({
  name: "workbench-tools-api",
  configureServer(server) {
    server.middlewares.use(
      guardedApi(async (request, response, next, url) => {
        if (!isToolsApiRoute(url.pathname)) return next();
        const rootDirectory = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
        const handled = await handleToolsApi({
          method: request.method,
          pathname: url.pathname,
          host: request.headers.host,
          origin: request.headers.origin,
          rootDirectory,
          getStatus,
          setupTool,
        });
        if (!handled) return next();
        sendJson(response, handled.status, handled.json);
      }),
    );
  },
});
