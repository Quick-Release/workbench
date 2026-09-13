import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { mattPocockSkillSource } from "../../src/lib/skills.ts";

const MATT_POCOCK_SOURCE = mattPocockSkillSource.repository;

// The lockfile is the primary installed signal; these well-known directories
// also cover installs made before the skills CLI started writing a lockfile.
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

const mattPocockIdsFromLockfile = async (rootDirectory) => {
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

// Installed ids are read live from the host repo: the snapshot's Catalog is
// stale by design, but installed state must reflect what is on disk now.
export const installedSkillIds = async (rootDirectory) => {
  const ids = new Set([
    ...(await mattPocockIdsFromLockfile(rootDirectory)),
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

// Join the sync-time Catalog with the host repo's live installed state. An
// installed skill absent from the Catalog remains visible so the seam never
// misrepresents the host repo.
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
      entries.set(id, {
        id,
        category: "",
        source: mattPocockSkillSource.id,
        installed: true,
      });
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
        id: mattPocockSkillSource.id,
        source: MATT_POCOCK_SOURCE,
        repositoryUrl: mattPocockSkillSource.repositoryUrl,
        installCommand: mattPocockSkillSource.installCommand,
        installed: installedSkills.length > 0,
        installedSkillCount: installedSkills.length,
        totalSkillCount: skills.length,
      },
    ],
    skills,
  };
};
