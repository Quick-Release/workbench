import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { mattPocockSkillSource } from "../../../src/lib/skills.ts";
import { skillsStatus } from "../../host/skills.mjs";

import { guardedApi, methodMismatch, sendJson } from "../middleware/api-shared.mjs";
import { gateRejection } from "../middleware/request-gate.mjs";

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

const STATUS_ROUTE = /^\/api\/skills\/?$/;
const INSTALL_ROUTE = /^\/api\/skills\/([\w-]+)\/install$/;
const SETUP_ROUTE = /^\/api\/skills\/([\w-]+)\/setup$/;

export const isSkillsApiRoute = (pathname) =>
  STATUS_ROUTE.test(pathname) || INSTALL_ROUTE.test(pathname) || SETUP_ROUTE.test(pathname);

const errorMessage = (error, fallback) =>
  String(error?.stderr ?? error?.message ?? error ?? fallback);

// The Catalog the seam joins against comes from the sync snapshot module, so
// the payload always mirrors what the browser bundles. An unavailable Catalog
// is distinct from an empty Catalog: installing an arbitrary skill when the
// allowlist could not be read would fail open.
const loadCatalog = async (server) => {
  try {
    const module = await server.ssrLoadModule("/src/data.ts");
    const catalog = module.overviewData?.skills;
    if (!Array.isArray(catalog)) return { catalog: [], available: false };
    return { catalog, available: true };
  } catch {
    return { catalog: [], available: false };
  }
};

const installMattPocockSkill = (rootDirectory, id) => installSkill(rootDirectory, id);

// The skills execution seam is kept pure at the HTTP boundary: the Catalog,
// status read, and installers are injected, while the shared gate and
// response contract remain exercised by route tests.
export const handleSkillsApi = async ({
  method,
  pathname,
  host,
  origin,
  rootDirectory,
  catalog = [],
  catalogAvailable = false,
  getStatus = skillsStatus,
  install = installMattPocockSkill,
  installAll = installMattPocockSkills,
}) => {
  if (!isSkillsApiRoute(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (STATUS_ROUTE.test(pathname)) {
    if (method !== "GET") return methodMismatch("GET");
    try {
      return { status: 200, json: await getStatus(rootDirectory, catalog) };
    } catch (error) {
      return {
        status: 500,
        json: { message: errorMessage(error, "Unable to read skill status.") },
      };
    }
  }

  const installMatch = INSTALL_ROUTE.exec(pathname);
  if (installMatch) {
    if (method !== "POST") return methodMismatch("POST");
    const id = installMatch[1];
    if (!catalogAvailable)
      return {
        status: 503,
        json: {
          error: "catalog_unavailable",
          message: "the skill Catalog is unavailable; refusing to install an unverified skill",
        },
      };
    if (!catalog.some((skill) => skill.id === id))
      return { status: 404, json: { message: `Unknown skill: ${id}` } };

    try {
      const message = await install(rootDirectory, id);
      return {
        status: 200,
        json: { message, ...(await getStatus(rootDirectory, catalog)) },
      };
    } catch (error) {
      return { status: 500, json: { message: errorMessage(error, "Skill installation failed.") } };
    }
  }

  const setupMatch = SETUP_ROUTE.exec(pathname);
  if (setupMatch) {
    if (method !== "POST") return methodMismatch("POST");
    if (setupMatch[1] !== mattPocockSkillSource.id)
      return { status: 404, json: { message: `Unknown skill source: ${setupMatch[1]}` } };

    try {
      const message = await installAll(rootDirectory);
      return {
        status: 200,
        json: { message, ...(await getStatus(rootDirectory, catalog)) },
      };
    } catch (error) {
      return { status: 500, json: { message: errorMessage(error, "Skill installation failed.") } };
    }
  }

  return null;
};

export const skillsApiPlugin = ({
  getStatus = skillsStatus,
  install = installMattPocockSkill,
  installAll = installMattPocockSkills,
} = {}) => ({
  name: "workbench-skills-api",
  configureServer(server) {
    server.middlewares.use(
      guardedApi(async (request, response, next, url) => {
        if (!isSkillsApiRoute(url.pathname)) return next();
        const rootDirectory = repositoryRoot(server);
        const catalogState = await loadCatalog(server);
        const handled = await handleSkillsApi({
          method: request.method,
          pathname: url.pathname,
          host: request.headers.host,
          origin: request.headers.origin,
          rootDirectory,
          catalog: catalogState.catalog,
          catalogAvailable: catalogState.available,
          getStatus,
          install,
          installAll,
        });
        if (!handled) return next();
        sendJson(response, handled.status, handled.json);
      }),
    );
  },
});
