import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { installSkill } from "./skills-api.mjs";
import { perSkillInstallCommand } from "../../../src/lib/skills.ts";

const withRoot = async (fn) => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-skills-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

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
