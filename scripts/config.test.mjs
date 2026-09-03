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

test("validates github and gitlab service declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-config-"));
  try {
    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({
        services: [
          { id: "gh", type: "github", repo: "example/project" },
          {
            id: "gl",
            type: "gitlab",
            projectPath: "group/project",
            apiBaseUrl: "https://gitlab.example.com/api/v4/",
          },
        ],
      }),
    );
    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.services[0].type, "github");
    strictEqual(config.services[0].repo, "example/project");
    strictEqual(config.services[1].projectPath, "group/project");
    strictEqual(config.services[1].apiBaseUrl, "https://gitlab.example.com/api/v4");

    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({ services: [{ id: "gh", type: "github", repo: "not-a-repo" }] }),
    );
    await rejects(loadWorkbenchConfig(directory), /repo must be in owner\/name format/);

    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({ services: [{ id: "gl", type: "gitlab" }] }),
    );
    await rejects(loadWorkbenchConfig(directory), /projectId or a projectPath/);

    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({
        services: [{ id: "gl", type: "gitlab", projectId: "not-numeric" }],
      }),
    );
    await rejects(loadWorkbenchConfig(directory), /projectId must be a numeric/);

    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({
        services: [{ id: "gh", type: "github", repo: "a/b", apiBaseUrl: "ftp://api.example.com" }],
      }),
    );
    await rejects(loadWorkbenchConfig(directory), /apiBaseUrl must be an http\(s\) URL/);
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

test("sessions sync is opt-in and defaults to disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-config-"));
  try {
    const absent = await loadWorkbenchConfig(directory);
    deepStrictEqual(absent.sessions, { enabled: false, databasePath: undefined });

    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({
        sessions: { enabled: true, databasePath: "~/.zcode/cli/db/db.sqlite" },
      }),
    );
    const enabled = await loadWorkbenchConfig(directory);
    strictEqual(enabled.sessions.enabled, true);
    strictEqual(enabled.sessions.databasePath, "~/.zcode/cli/db/db.sqlite");

    await writeFile(join(directory, "workbench.config.json"), JSON.stringify({ sessions: {} }));
    const partial = await loadWorkbenchConfig(directory);
    deepStrictEqual(partial.sessions, { enabled: false, databasePath: undefined });

    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({ sessions: { enabled: "yes" } }),
    );
    await rejects(loadWorkbenchConfig(directory), /sessions\.enabled must be a boolean/);

    await writeFile(
      join(directory, "workbench.config.json"),
      JSON.stringify({ sessions: { enabled: true, databasePath: "  " } }),
    );
    await rejects(loadWorkbenchConfig(directory), /sessions\.databasePath/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
