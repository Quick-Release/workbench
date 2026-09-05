import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { installSkill, installedSkillIds, skillsStatus } from "./skills-api.mjs";
import { perSkillInstallCommand } from "../src/lib/skills.ts";

const withRoot = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-skills-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const catalog = [
  { id: "tdd", category: "engineering", source: "matt-pocock" },
  { id: "teach", category: "productivity", source: "matt-pocock" },
  { id: "wizard", category: "engineering", source: "matt-pocock" },
];

test("joins the catalog with live installed state read from disk", async () => {
  await withRoot(async (directory) => {
    await mkdir(join(directory, ".agents/skills/tdd"), { recursive: true });
    await writeFile(
      join(directory, ".agents/skills/tdd/SKILL.md"),
      "---\nname: tdd\ndescription: Red-green-refactor loops.\n---\n",
    );

    const status = await skillsStatus(directory, catalog);
    strictEqual(status.sources[0].installedSkillCount, 1);
    strictEqual(status.sources[0].totalSkillCount, 3);
    const tdd = status.skills.find((skill) => skill.id === "tdd");
    strictEqual(tdd.installed, true);
    strictEqual(tdd.description, "Red-green-refactor loops.");
    const wizard = status.skills.find((skill) => skill.id === "wizard");
    strictEqual(wizard.installed, false);
    strictEqual("description" in wizard, false);
  });
});

test("reports an installed skill that the catalog does not know about", async () => {
  await withRoot(async (directory) => {
    await mkdir(join(directory, ".claude/skills/only-on-disk"), { recursive: true });
    await writeFile(join(directory, ".claude/skills/only-on-disk/SKILL.md"), "---\nname: x\n---\n");

    const status = await skillsStatus(directory, catalog);
    const extra = status.skills.find((skill) => skill.id === "only-on-disk");
    strictEqual(extra.installed, true);
    strictEqual(extra.category, "");
  });
});

test("finds installs through the lockfile as well as skill directories", async () => {
  await withRoot(async (directory) => {
    await writeFile(
      join(directory, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          teach: { source: "mattpocock/skills", skillPath: "skills/productivity/teach/SKILL.md" },
          "other-source": { source: "someone/else", skillPath: "x" },
        },
      }),
    );
    deepStrictEqual(await installedSkillIds(directory), ["teach"]);
  });
});

test("installs exactly the requested skill through the skills CLI", async () => {
  await withRoot(async (directory) => {
    const calls = [];
    const run = async (root, args) => {
      calls.push({ root, args });
      return { stdout: "" };
    };
    const message = await installSkill(directory, "tdd", { run });
    strictEqual(calls.length, 1);
    deepStrictEqual(calls[0].args, [
      "--yes",
      "skills@latest",
      "add",
      "mattpocock/skills",
      "--skill",
      "tdd",
    ]);
    strictEqual(calls[0].root, directory);
    strictEqual(
      message,
      "Installed tdd from mattpocock/skills. Restart your coding agent to discover it.",
    );
    strictEqual(
      perSkillInstallCommand("tdd"),
      "npx skills@latest add mattpocock/skills --skill tdd",
    );
  });
});
