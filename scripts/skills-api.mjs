import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MATT_POCOCK_SOURCE_ID = "matt-pocock";
const MATT_POCOCK_SOURCE = "mattpocock/skills";
const MATT_POCOCK_REPOSITORY_URL = "https://github.com/mattpocock/skills";

// Keep this list in sync with the public collection's current catalog. The
// lockfile is the primary status signal, while these directories also cover
// installs made before the skills CLI started writing a lockfile.
const MATT_POCOCK_SKILL_IDS = [
  "ask-matt",
  "claude-handoff",
  "code-review",
  "codebase-design",
  "diagnosing-bugs",
  "domain-modeling",
  "git-guardrails-claude-code",
  "grill-me",
  "grill-with-docs",
  "grilling",
  "handoff",
  "implement",
  "implement-spec",
  "improve-codebase-architecture",
  "loop-me",
  "migrate-to-shoehorn",
  "prototype",
  "research",
  "resolving-merge-conflicts",
  "retro",
  "scaffold-exercises",
  "setup-matt-pocock-skills",
  "setup-pre-commit",
  "setup-ts-deep-modules",
  "tdd",
  "teach",
  "to-questionnaire",
  "to-spec",
  "to-tickets",
  "triage",
  "wait-what",
  "wayfinder",
  "wizard",
  "writing-beats",
  "writing-for-agents",
  "writing-fragments",
  "writing-shape",
];

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

const installedSkillIdsFromLockfile = async (rootDirectory) => {
  const lockfile = await readJson(join(rootDirectory, "skills-lock.json")).catch(() => null);
  if (!lockfile || typeof lockfile.skills !== "object" || lockfile.skills === null) return [];
  return Object.entries(lockfile.skills)
    .filter(([, entry]) => entry?.source === MATT_POCOCK_SOURCE)
    .map(([id]) => id)
    .filter((id) => MATT_POCOCK_SKILL_IDS.includes(id));
};

const installedSkillIdsFromDirectories = async (rootDirectory) => {
  const found = new Set();
  for (const directory of PROJECT_SKILL_DIRECTORIES) {
    const present = await Promise.all(
      MATT_POCOCK_SKILL_IDS.map(async (id) =>
        (await fileExists(join(rootDirectory, directory, id, "SKILL.md"))) ? id : null,
      ),
    );
    for (const id of present) if (id) found.add(id);
  }
  return [...found];
};

export const skillsStatus = async (rootDirectory) => {
  const installed = new Set([
    ...(await installedSkillIdsFromLockfile(rootDirectory)),
    ...(await installedSkillIdsFromDirectories(rootDirectory)),
  ]);
  const installedSkills = MATT_POCOCK_SKILL_IDS.filter((id) => installed.has(id));
  return {
    skills: [
      {
        id: MATT_POCOCK_SOURCE_ID,
        source: MATT_POCOCK_SOURCE,
        repositoryUrl: MATT_POCOCK_REPOSITORY_URL,
        installed: installedSkills.length > 0,
        installedSkills,
        installedSkillCount: installedSkills.length,
        totalSkillCount: MATT_POCOCK_SKILL_IDS.length,
      },
    ],
  };
};

const installMattPocockSkills = async (rootDirectory) => {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  await execFileAsync(npx, ["--yes", "skills@latest", "add", MATT_POCOCK_SOURCE, "--all"], {
    cwd: rootDirectory,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return "Installed Matt Pocock Skills in the repository. Restart your coding agent to discover them.";
};

const repositoryRoot = (server) => resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);

const sendJson = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
};

export const skillsApiPlugin = () => ({
  name: "workbench-skills-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const statusMatch = url.pathname.match(/^\/api\/skills\/?$/);
      const setupMatch = url.pathname.match(/^\/api\/skills\/([\w-]+)\/(?:setup|install)$/);

      if (request.method === "GET" && statusMatch) {
        try {
          sendJson(response, 200, await skillsStatus(repositoryRoot(server)));
        } catch (error) {
          sendJson(response, 500, {
            message: error instanceof Error ? error.message : "Unable to read skill status.",
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
          sendJson(response, 200, { message, ...(await skillsStatus(rootDirectory)) });
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
