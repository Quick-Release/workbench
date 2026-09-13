import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deepStrictEqual, strictEqual } from "node:assert";
import test from "node:test";

import { handleSkillsApi, installSkill, isSkillsApiRoute } from "./skills-api.mjs";
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

const loopback = { host: "localhost:4051", origin: "http://localhost:4051" };
const catalog = [{ id: "tdd", category: "engineering", source: "matt-pocock" }];
const status = { skills: [{ id: "tdd", installed: false }] };

const skillDependencies = (overrides = {}) => ({
  method: "POST",
  pathname: "/api/skills/tdd/install",
  rootDirectory: "/host/repo",
  catalog,
  catalogAvailable: true,
  getStatus: async () => status,
  install: async () => "Installed tdd.",
  ...loopback,
  ...overrides,
});

test("recognizes skill status, install, and setup routes only", () => {
  strictEqual(isSkillsApiRoute("/api/skills"), true);
  strictEqual(isSkillsApiRoute("/api/skills/tdd/install"), true);
  strictEqual(isSkillsApiRoute("/api/skills/matt-pocock/setup"), true);
  strictEqual(isSkillsApiRoute("/api/tools"), false);
});

test("rejects a foreign host before installing a skill", async () => {
  let installs = 0;
  const handled = await handleSkillsApi(
    skillDependencies({
      host: "host-repo.example:4051",
      install: async () => {
        installs += 1;
        return "should not run";
      },
    }),
  );

  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "forbidden_host");
  strictEqual(installs, 0);
});

test("rejects a cross-origin skill installation", async () => {
  const handled = await handleSkillsApi(skillDependencies({ origin: "http://evil.example:4051" }));

  strictEqual(handled.status, 403);
  strictEqual(handled.json.error, "cross_origin");
});

test("fails closed when the skill catalog is unavailable", async () => {
  let installs = 0;
  const handled = await handleSkillsApi(
    skillDependencies({
      catalogAvailable: false,
      install: async () => {
        installs += 1;
        return "should not run";
      },
    }),
  );

  strictEqual(handled.status, 503);
  strictEqual(handled.json.error, "catalog_unavailable");
  strictEqual(installs, 0);
});

test("installs a catalog skill and returns refreshed status", async () => {
  const calls = [];
  const handled = await handleSkillsApi(
    skillDependencies({
      getStatus: async (directory, loadedCatalog) => {
        calls.push({ kind: "status", directory, loadedCatalog });
        return status;
      },
      install: async (directory, id) => {
        calls.push({ kind: "install", directory, id });
        return "Installed tdd.";
      },
    }),
  );

  strictEqual(handled.status, 200);
  deepStrictEqual(handled.json, { message: "Installed tdd.", ...status });
  deepStrictEqual(calls, [
    { kind: "install", directory: "/host/repo", id: "tdd" },
    { kind: "status", directory: "/host/repo", loadedCatalog: catalog },
  ]);
});
