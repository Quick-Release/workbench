import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { mattPocockSkillSource } from "../../../src/lib/skills.ts";
import { skillsStatus } from "../../host/skills.mjs";

import { guardedApi, sendJson } from "../middleware/api-shared.mjs";

const execFileAsync = promisify(execFile);

const MATT_POCOCK_SOURCE = mattPocockSkillSource.repository;

const runSkillsCli = (rootDirectory, args) => {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return execFileAsync(npx, args, {
    cwd: rootDirectory,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
};

// Per-skill install (ADR 0005 phase-1 action): the skills CLI for exactly the
// requested skill. `run` is injectable so tests stub the shell-out.
export const installSkill = async (rootDirectory, id, { run = runSkillsCli } = {}) => {
  await run(rootDirectory, ["--yes", "skills@latest", "add", MATT_POCOCK_SOURCE, "--skill", id]);
  return `Installed ${id} from ${MATT_POCOCK_SOURCE}. Restart your coding agent to discover it.`;
};

const installMattPocockSkills = async (rootDirectory) => {
  await runSkillsCli(rootDirectory, ["--yes", "skills@latest", "add", MATT_POCOCK_SOURCE, "--all"]);
  return "Installed Matt Pocock Skills in the repository. Restart your coding agent to discover them.";
};

const repositoryRoot = (server) => resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);

// The Catalog the seam joins against comes from the sync snapshot module, so
// the payload always mirrors what the browser bundles.
const loadCatalog = async (server) => {
  try {
    const module = await server.ssrLoadModule("/src/data.ts");
    return module.overviewData?.skills ?? [];
  } catch {
    return [];
  }
};

export const skillsApiPlugin = () => ({
  name: "workbench-skills-api",
  configureServer(server) {
    server.middlewares.use(
      guardedApi(async (request, response, next, url) => {
        const statusMatch = url.pathname.match(/^\/api\/skills\/?$/);
        const installMatch = url.pathname.match(/^\/api\/skills\/([\w-]+)\/install$/);
        const setupMatch = url.pathname.match(/^\/api\/skills\/([\w-]+)\/setup$/);

        if (request.method === "GET" && statusMatch) {
          try {
            const catalog = await loadCatalog(server);
            sendJson(response, 200, await skillsStatus(repositoryRoot(server), catalog));
          } catch (error) {
            sendJson(response, 500, {
              message: error instanceof Error ? error.message : "Unable to read skill status.",
            });
          }
          return;
        }

        if (request.method === "POST" && installMatch) {
          const id = installMatch[1];
          const rootDirectory = repositoryRoot(server);
          const catalog = await loadCatalog(server);
          if (catalog.length > 0 && !catalog.some((skill) => skill.id === id)) {
            sendJson(response, 404, { message: `Unknown skill: ${id}` });
            return;
          }
          try {
            const message = await installSkill(rootDirectory, id);
            sendJson(response, 200, {
              message,
              ...(await skillsStatus(rootDirectory, catalog)),
            });
          } catch (error) {
            sendJson(response, 500, {
              message: String(
                error?.stderr ?? error?.message ?? error ?? "Skill installation failed.",
              ),
            });
          }
          return;
        }

        if (request.method === "POST" && setupMatch) {
          if (setupMatch[1] !== mattPocockSkillSource.id) {
            sendJson(response, 404, { message: `Unknown skill source: ${setupMatch[1]}` });
            return;
          }
          try {
            const rootDirectory = repositoryRoot(server);
            const message = await installMattPocockSkills(rootDirectory);
            sendJson(response, 200, {
              message,
              ...(await skillsStatus(rootDirectory, await loadCatalog(server))),
            });
          } catch (error) {
            sendJson(response, 500, {
              message: String(
                error?.stderr ?? error?.message ?? error ?? "Skill installation failed.",
              ),
            });
          }
          return;
        }

        next();
      }),
    );
  },
});
