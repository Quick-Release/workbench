import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_THEME, loadWorkbenchConfig } from "./config.mjs";

test("uses safe defaults when a project has no config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-config-"));
  try {
    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.projectName, undefined);
    strictEqual(config.repositoryUrl, undefined);
    deepStrictEqual(config.theme, DEFAULT_THEME);
    deepStrictEqual(config.services, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes semantic colors and service declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-config-"));
  try {
    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({
        projectName: "Example",
        repositoryUrl: "https://github.com/example/project/",
        theme: { accent: "#123456", background: "#111" },
        services: [
          {
            id: "roadmap",
            type: "ASANA",
            projectGid: "123",
            tokenEnv: "ASANA_TOKEN",
          },
        ],
      }),
    );
    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.projectName, "Example");
    strictEqual(config.repositoryUrl, "https://github.com/example/project");
    strictEqual(config.theme.acid, "#123456");
    strictEqual(config.theme.bg, "#111");
    strictEqual(config.services[0].type, "asana");
    strictEqual(config.services[0].tokenEnv, "ASANA_TOKEN");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects inline service credentials and invalid colors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-config-"));
  try {
    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({ theme: { accent: "var(--unsafe)" } }),
    );
    await rejects(loadWorkbenchConfig(directory), /theme\.accent/);

    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({
        services: [
          {
            id: "roadmap",
            type: "asana",
            token: "must-not-be-here",
          },
        ],
      }),
    );
    await rejects(loadWorkbenchConfig(directory), /tokenEnv/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
