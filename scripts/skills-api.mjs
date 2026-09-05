import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MATT_POCOCK_SOURCE_ID = "matt-pocock";
const MATT_POCOCK_SOURCE = "mattpocock/skills";
const MATT_POCOCK_REPOSITORY_URL = "https://github.com/mattpocock/skills";
export const MATT_POCOCK_INSTALL_ALL_COMMAND = "npx skills@latest add mattpocock/skills --all";

// ADR 0006: the hardcoded 37-id list is gone — the Catalog comes from sync
// (upstream fetch, last-good, curated fallback) and the seam joins it with
// live disk state. The lockfile is the primary installed signal; the
// well-known skill directories also cover installs made before the skills
// CLI started writing a lockfile.

const PROJECT_SKILL_DIRECTORIES = [
  ".agents/skills",
  ".claude/skills",
  ".cursor/skills",
  ".gemini/skills",
  ".opencode/skills",
  ".pi/skills",
  ".zcode/skills",
  "skills",
];

const fileExists = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const idsFromLockfile = async (rootDirectory) => {
  const lockfile = await readJson(join(rootDirectory, "skills-lock.json")).catch(() => null);
  if (!lockfile || typeof lockfile.skills !== "object" || lockfile.skills === null) return [];
  return Object.entries(lockfile.skills)
    .filter(([, entry]) => entry?.source === MATT_POCOCK_SOURCE)
    .map(([id]) => id);
};

const idsFromDirectories = async (rootDirectory) => {
  const found = new Set();
  for (const directory of PROJECT_SKILL_DIRECTORIES) {
    const entries = await readdir(join(rootDirectory, directory), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await fileExists(join(rootDirectory, directory, entry.name, "SKILL.md"))) {
        found.add(entry.name);
      }
    }
  }
  return [...found];
};

// Installed ids read live from disk: lockfile plus well-known directories,
// unfiltered — disk is the only truth for installed.
export const installedSkillIds = async (rootDirectory) => {
  const ids = new Set([
    ...(await idsFromLockfile(rootDirectory)),
    ...(await idsFromDirectories(rootDirectory)),
  ]);
  return [...ids].sort((left, right) => left.localeCompare(right));
};

const frontmatterDescription = async (rootDirectory, id) => {
  for (const directory of PROJECT_SKILL_DIRECTORIES) {
    const path = join(rootDirectory, directory, id, "SKILL.md");
    if (!(await fileExists(path))) continue;
    const text = await readFile(path, "utf8").catch(() => "");
    const match = text.match(/^description:\s*(.+)$/m);
    const description = match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
    return description || undefined;
  }
  return undefined;
};

// The joined read: every Catalog entry with live installed state, plus any
// installed skill the catalog does not know about. Descriptions resolve from
// installed frontmatter here; the browser falls back to the curated blurb,
// then the name.
export const skillsStatus = async (rootDirectory, catalog = []) => {
  const installed = new Set(await installedSkillIds(rootDirectory));
  const entries = new Map(
    catalog.map((skill) => [
      skill.id,
      {
        id: skill.id,
        category: skill.category,
        source: skill.source,
        installed: installed.has(skill.id),
      },
    ]),
  );
  for (const id of installed) {
    if (!entries.has(id)) {
      entries.set(id, { id, category: "", source: MATT_POCOCK_SOURCE_ID, installed: true });
    }
  }
  const skills = [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (const skill of skills) {
    if (skill.installed) {
      const description = await frontmatterDescription(rootDirectory, skill.id);
      if (description) skill.description = description;
    }
  }
  const installedSkills = skills.filter((skill) => skill.installed);
  return {
    sources: [
      {
        id: MATT_POCOCK_SOURCE_ID,
        source: MATT_POCOCK_SOURCE,
        repositoryUrl: MATT_POCOCK_REPOSITORY_URL,
        installCommand: MATT_POCOCK_INSTALL_ALL_COMMAND,
        installed: installedSkills.length > 0,
        installedSkillCount: installedSkills.length,
        totalSkillCount: skills.length,
      },
    ],
    skills,
  };
};

export const perSkillInstallCommand = (id) =>
  `npx skills@latest add ${MATT_POCOCK_SOURCE} --skill ${id}`;

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

const sendJson = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
};

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
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const statusMatch = url.pathname.match(/^\/api\/skills\/?$/);
      const installMatch = url.pathname.match(/^\/api\/skills\/([\w-]+)\/install$/);
      const setupMatch = url.pathname.match(/^\/api\/skills\/([\w-]+)\/(?:setup|install-all)$/);

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
        if (setupMatch[1] !== MATT_POCOCK_SOURCE_ID) {
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
    });
  },
});
