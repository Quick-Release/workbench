import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strictEqual } from "node:assert";
import test from "node:test";

import { skillsStatus } from "./skills-api.mjs";

const withRoot = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-skills-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("reports an uninstalled Matt Pocock collection without a lockfile", async () => {
  await withRoot(async (directory) => {
    const status = await skillsStatus(directory);
    const [source] = status.skills;
    strictEqual(source.installed, false);
    strictEqual(source.installedSkillCount, 0);
    strictEqual(source.totalSkillCount, 37);
  });
});

test("finds a collection installed in the project skills directory", async () => {
  await withRoot(async (directory) => {
    await mkdir(join(directory, ".agents/skills/code-review"), { recursive: true });
    await writeFile(
      join(directory, ".agents/skills/code-review/SKILL.md"),
      "---\nname: code-review\n---\n",
    );

    const status = await skillsStatus(directory);
    const [source] = status.skills;
    strictEqual(source.installed, true);
    strictEqual(source.installedSkillCount, 1);
    strictEqual(source.installedSkills[0], "code-review");
  });
});
