import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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

export const toolsApiPlugin = () => ({
  name: "workbench-tools-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const rootDirectory = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
      const url = new URL(request.url, "http://localhost");
      const statusMatch = url.pathname.match(/^\/api\/tools\/?$/);
      const setupMatch = url.pathname.match(/^\/api\/tools\/([\w-]+)\/setup$/);

      if (request.method === "GET" && statusMatch) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(await toolsStatus(rootDirectory)));
        return;
      }

      if (request.method === "POST" && setupMatch) {
        const setup = setups[setupMatch[1]];
        if (!setup) {
          response.statusCode = 404;
          response.end(`Unknown tool: ${setupMatch[1]}`);
          return;
        }
        try {
          const message = await setup(rootDirectory);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ message, ...(await toolsStatus(rootDirectory)) }));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ message: String(error?.stderr ?? error ?? "Setup failed") }),
          );
        }
        return;
      }

      next();
    });
  },
});
