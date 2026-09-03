import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { match, strictEqual } from "node:assert";
import test from "node:test";
import { Readable, Writable } from "node:stream";

import { loadWorkbenchConfig } from "./config.mjs";
import { runInit } from "./init.mjs";

const tmpRoot = async () => mkdtemp(join(tmpdir(), "workbench-init-"));

const withRoot = async (fn) => {
  const directory = await tmpRoot();
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// Mock stream doubles following the pattern of clack's own suites: a push-driven
// Readable that emits keypress bytes, and a Writable that captures everything.
class MockWritable extends Writable {
  chunks = [];
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  text() {
    return this.chunks.map((chunk) => chunk.toString("utf8")).join("");
  }
}

class MockReadable extends Readable {
  _read() {}
}

const mockStreams = () => ({ input: new MockReadable(), output: new MockWritable() });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Send one batch of keystrokes, giving the active prompt time to consume them.
const submit = async (input, keys) => {
  await wait(15);
  input.push(keys);
};

// Clear a pre-filled text field (excess backspaces are no-ops), then type.
const clearAndType = async (input, keys) => submit(input, `\x7f`.repeat(80) + keys);

const assertNoConfig = async (directory) => {
  await stat(join(directory, "workbench.config.json")).then(
    () => {
      throw new Error("config file must not exist");
    },
    (error) => {
      strictEqual(error.code, "ENOENT");
    },
  );
};

test("non-interactive run prints instructions, prompts nobody, and writes nothing", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const result = await runInit({ rootDirectory: directory, input, output, interactive: false });
    strictEqual(result.status, "blocked");
    match(output.text(), /non-interactive/i);
    match(output.text(), /workbench\.config\.json/);
    await assertNoConfig(directory);
  });
});

test("happy path writes a config that loads through the existing loader", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    // projectName → repositoryUrl → multiselect (toggle github) → repo → tokenEnv → add another? No
    await clearAndType(input, "My Project\r");
    await clearAndType(input, "https://github.com/example/project/\r");
    await submit(input, " \r");
    await clearAndType(input, "example/other\r");
    await submit(input, "GITHUB_TOKEN\r");
    await submit(input, "\r");

    const result = await flow;
    strictEqual(result.status, "written");
    match(output.text(), /workbench\.config\.json/);

    // The oracle: whatever init wrote must load and normalize via the loader.
    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.projectName, "My Project");
    strictEqual(config.repositoryUrl, "https://github.com/example/project");
    strictEqual(config.services.length, 1);
    strictEqual(config.services[0].type, "github");
    strictEqual(config.services[0].repo, "example/other");
    strictEqual(config.services[0].tokenEnv, "GITHUB_TOKEN");

    // Tokens never land in the file, only env names.
    const raw = await readFile(join(directory, "workbench.config.json"), "utf8");
    match(raw, /GITHUB_TOKEN/);
    match(raw, /tokenEnv/);
    if (raw.includes('"token"')) throw new Error("inline token written");
  });
});

test("origin remote becomes the accepted-by-enter default for URL and GitHub repo", async () => {
  await withRoot(async (directory) => {
    await new Promise((resolve, reject) =>
      execFile("git", ["init", "-q"], { cwd: directory }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await new Promise((resolve, reject) =>
      execFile(
        "git",
        ["remote", "add", "origin", "git@github.com:example/project.git"],
        { cwd: directory },
        (error) => (error ? reject(error) : resolve()),
      ),
    );

    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    // projectName default (directory name) → repositoryUrl default (origin) →
    // multiselect github → repo default (owner/name from origin) → tokenEnv → done
    await submit(input, "\r");
    await submit(input, "\r");
    await submit(input, " \r");
    await submit(input, "\r");
    await submit(input, "GITHUB_TOKEN\r");
    await submit(input, "\r");

    const result = await flow;
    strictEqual(result.status, "written");

    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.repositoryUrl, "https://github.com/example/project");
    strictEqual(config.services[0].repo, "example/project");
    match(config.projectName, /^workbench-init-/);
  });
});

test("escape cancels the flow just like Ctrl+C", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    await submit(input, "\x1b"); // escape at the first prompt

    const result = await flow;
    strictEqual(result.status, "cancelled");
    match(output.text(), /No changes written/);
    await assertNoConfig(directory);
  });
});

test("cancelling mid-flow writes nothing", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    await submit(input, "\x03"); // Ctrl+C at the first prompt

    const result = await flow;
    strictEqual(result.status, "cancelled");
    match(output.text(), /No changes written/);
    await assertNoConfig(directory);
  });
});

test("cancelling at the add-another prompt keeps the earlier answers unwritten", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    await clearAndType(input, "My Project\r");
    await clearAndType(input, "https://github.com/example/project\r");
    await submit(input, " \r");
    await clearAndType(input, "example/other\r");
    await submit(input, "GITHUB_TOKEN\r");
    await submit(input, "\x03"); // Ctrl+C at "Add another github service?"

    const result = await flow;
    strictEqual(result.status, "cancelled");
    await assertNoConfig(directory);
  });
});

test("declining the overwrite confirmation leaves the existing config untouched", async () => {
  await withRoot(async (directory) => {
    await writeFile(join(directory, "workbench.config.json"), "SENTINEL");

    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    // confirm overwrite → "n" declines
    await submit(input, "n\r");

    const result = await flow;
    strictEqual(result.status, "cancelled");
    strictEqual(await readFile(join(directory, "workbench.config.json"), "utf8"), "SENTINEL");
  });
});

test("re-running init offers existing values as accepted-by-enter defaults", async () => {
  await withRoot(async (directory) => {
    await writeFile(
      join(directory, "workbench.config.json"),
      `${JSON.stringify({
        projectName: "Old Name",
        repositoryUrl: "https://github.com/example/old",
        services: [{ id: "github", type: "github", repo: "example/old", tokenEnv: "OLD_TOKEN" }],
      })}\n`,
    );

    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    // "y" accept overwrite → name (default) → URL (default) → services (preselected github,
    // submit as-is) → repo (default) → tokenEnv (typed) → add another? No
    await submit(input, "y\r");
    await submit(input, "\r");
    await submit(input, "\r");
    await submit(input, "\r");
    await submit(input, "\r");
    await clearAndType(input, "GITHUB_TOKEN\r");
    await submit(input, "\r");

    const result = await flow;
    strictEqual(result.status, "written");

    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.projectName, "Old Name");
    strictEqual(config.repositoryUrl, "https://github.com/example/old");
    strictEqual(config.services.length, 1);
    strictEqual(config.services[0].id, "github");
    strictEqual(config.services[0].repo, "example/old");
    strictEqual(config.services[0].tokenEnv, "GITHUB_TOKEN");
  });
});

test("invalid token env name is rejected at the prompt, then accepted once valid", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    await clearAndType(input, "My Project\r");
    await clearAndType(input, "https://github.com/example/project\r");
    await submit(input, " \r");
    await clearAndType(input, "example/other\r");
    await submit(input, "bad_name\r"); // rejected: lowercase env name
    await clearAndType(input, "GITHUB_TOKEN\r"); // accepted
    await submit(input, "\r");

    const result = await flow;
    strictEqual(result.status, "written");
    match(output.text(), /environment variable name/i);

    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.services[0].tokenEnv, "GITHUB_TOKEN");
  });
});

test("gitlab services collect a project path and token env", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    // projectName → URL → multiselect (down to gitlab, toggle) → mode (projectPath
    // default) → path → tokenEnv → done
    await clearAndType(input, "My Project\r");
    await clearAndType(input, "https://gitlab.example.com/group/project\r");
    await submit(input, "\x1b[B \r");
    await submit(input, "\r");
    await submit(input, "group/project\r");
    await submit(input, "GITLAB_TOKEN\r");
    await submit(input, "\r");

    const result = await flow;
    strictEqual(result.status, "written");

    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.services.length, 1);
    strictEqual(config.services[0].type, "gitlab");
    strictEqual(config.services[0].projectPath, "group/project");
    strictEqual(config.services[0].tokenEnv, "GITLAB_TOKEN");
  });
});

test("two services of the same type get distinct stable ids", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    await clearAndType(input, "My Project\r");
    await clearAndType(input, "https://github.com/example/project\r");
    await submit(input, " \r");
    await clearAndType(input, "example/one\r");
    await submit(input, "ONE_TOKEN\r");
    await submit(input, "y\r"); // add another github service
    await clearAndType(input, "example/two\r");
    await submit(input, "TWO_TOKEN\r");
    await submit(input, "\r"); // done

    const result = await flow;
    strictEqual(result.status, "written");

    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.services.length, 2);
    strictEqual(config.services[0].id, "github");
    strictEqual(config.services[0].repo, "example/one");
    strictEqual(config.services[1].id, "github-2");
    strictEqual(config.services[1].repo, "example/two");
  });
});
