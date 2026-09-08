import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

// Mock stream doubles following the pattern of clack's own suites: an inert
// Readable for prompts to attach to, and a Writable that captures everything.
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

// Translate one keystroke byte into the keypress event a terminal would emit
// for it. Events are synthesized instead of pushing raw bytes because the byte
// path rides readline's terminal decoding, which drops or garbles control keys
// on in-memory streams and deadlocks the flow (#69).
const keypresses = function* (keys) {
  for (let i = 0; i < keys.length;) {
    if (keys.startsWith("\x1b[B", i)) {
      yield ["", { name: "down", sequence: "\x1b[B" }];
      i += 3;
      continue;
    }
    const ch = keys[i];
    const named =
      ch === "\r"
        ? "return"
        : ch === "\x03"
          ? "c"
          : ch === "\x1b"
            ? "escape"
            : ch === " "
              ? "space"
              : ch;
    // Named keys other than space carry an empty payload like clack's own
    // suites do, so they can never masquerade as typed text; space keeps its
    // character so a prompt that types it inserts it, while clack still
    // dispatches the multiselect toggle from the key's name.
    yield [named === ch || named === "space" ? ch : "", { name: named, sequence: ch }];
    i += 1;
  }
};

// Send one batch of keystrokes, giving the active prompt time to consume them.
const submit = async (input, keys) => {
  await wait(15);
  for (const [ch, key] of keypresses(keys)) input.emit("keypress", ch, key);
};

// Fixture git calls target a scratch directory, so they must ignore whatever
// git context the caller runs the suite under (a pre-commit hook exports
// GIT_DIR and friends); otherwise the fixtures build inside the caller's repo.
const execGit = (args, cwd) =>
  new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("GIT_")) delete env[key];
    }
    execFile("git", args, { cwd, env }, (error) => (error ? reject(error) : resolve()));
  });

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

    // projectName (accept the directory-name default) → repositoryUrl (typed) →
    // multiselect (toggle github) → repo (accept the URL-inferred default) →
    // tokenEnv (typed) → add another? No
    await submit(input, "\r");
    await submit(input, "https://github.com/example/project\r");
    await submit(input, " \r");
    await submit(input, "\r");
    await submit(input, "GITHUB_TOKEN\r");
    await submit(input, "\r");

    const result = await flow;
    strictEqual(result.status, "written");
    match(output.text(), /workbench\.config\.json/);

    // The oracle: whatever init wrote must load and normalize via the loader.
    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.projectName, basename(directory));
    strictEqual(config.repositoryUrl, "https://github.com/example/project");
    strictEqual(config.services.length, 1);
    strictEqual(config.services[0].type, "github");
    strictEqual(config.services[0].repo, "example/project");
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
    await execGit(["init", "-q"], directory);
    await execGit(["remote", "add", "origin", "git@github.com:example/project.git"], directory);

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

test("the directory's own origin wins over inherited git context (hook env)", async () => {
  await withRoot(async (directory) => {
    await execGit(["init", "-q"], directory);
    await execGit(["remote", "add", "origin", "git@github.com:example/project.git"], directory);

    // A foreign git context, exactly the vars a pre-commit hook exports to its
    // suite. init probes the directory it is given, never the caller's repo.
    const foreign = await tmpRoot();
    await execGit(["init", "-q"], foreign);
    const inherited = {
      GIT_DIR: join(foreign, ".git"),
      GIT_WORK_TREE: foreign,
      GIT_INDEX_FILE: join(foreign, ".git", "index"),
    };
    const saved = new Map(Object.keys(inherited).map((key) => [key, process.env[key]]));
    Object.assign(process.env, inherited);

    try {
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
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

    // projectName (default) → repositoryUrl (typed) → multiselect (toggle github) →
    // repo (default) → tokenEnv (typed) → Ctrl+C at "Add another github service?"
    await submit(input, "\r");
    await submit(input, "https://github.com/example/project\r");
    await submit(input, " \r");
    await submit(input, "\r");
    await submit(input, "GITHUB_TOKEN\r");
    await submit(input, "\x03");

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

    // "y" accept overwrite → name (default) → URL (default) → services (preselected
    // github, submit as-is) → repo (default) → tokenEnv (default) → add another? No
    await submit(input, "y\r");
    await submit(input, "\r");
    await submit(input, "\r");
    await submit(input, "\r");
    await submit(input, "\r");
    await submit(input, "\r");
    await submit(input, "\r");

    const result = await flow;
    strictEqual(result.status, "written");

    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.projectName, "Old Name");
    strictEqual(config.repositoryUrl, "https://github.com/example/old");
    strictEqual(config.services.length, 1);
    strictEqual(config.services[0].id, "github");
    strictEqual(config.services[0].repo, "example/old");
    strictEqual(config.services[0].tokenEnv, "OLD_TOKEN");
  });
});

test("a rejected token env name blocks the prompt, then a valid one is accepted", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    // projectName (default) → URL (typed) → multiselect (toggle github) →
    // repo (default) → tokenEnv: submit empty (rejected: required), then type →
    // add another? No
    await submit(input, "\r");
    await submit(input, "https://github.com/example/project\r");
    await submit(input, " \r");
    await submit(input, "\r");
    await submit(input, "\r"); // rejected: the token env name is required
    await submit(input, "GITHUB_TOKEN\r"); // accepted
    await submit(input, "\r");

    const result = await flow;
    // If the empty submit had been accepted, the flow would have ended in the
    // staging gate rejecting the empty token env, not in a written config.
    strictEqual(result.status, "written");

    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.services[0].tokenEnv, "GITHUB_TOKEN");
  });
});

test("an invalid token env name is rejected at the prompt with a rendered reason", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    // projectName (default) → URL (typed) → multiselect (toggle github) →
    // repo (default) → tokenEnv: "bad_name" (rejected: the rendered reason is
    // the assertion) → Ctrl+C rather than clearing the rejected residue
    await submit(input, "\r");
    await submit(input, "https://github.com/example/project\r");
    await submit(input, " \r");
    await submit(input, "\r");
    await submit(input, "bad_name\r"); // rejected: lowercase env name
    await submit(input, "\x03");

    const result = await flow;
    strictEqual(result.status, "cancelled");
    match(output.text(), /environment variable name like GITHUB_TOKEN/i);
    await assertNoConfig(directory);
  });
});

test("gitlab services collect a project path and token env", async () => {
  await withRoot(async (directory) => {
    const { input, output } = mockStreams();
    const flow = runInit({ rootDirectory: directory, input, output, interactive: true });

    // projectName (default) → URL (typed) → multiselect (down to gitlab, toggle) →
    // mode (projectPath default) → path (typed) → tokenEnv (typed) → done
    await submit(input, "\r");
    await submit(input, "https://gitlab.example.com/group/project\r");
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

    // projectName (default) → URL (typed) → multiselect (toggle github) →
    // repo (default) → tokenEnv (typed) → add another? Yes → repo (default) →
    // tokenEnv (typed) → done
    await submit(input, "\r");
    await submit(input, "https://github.com/example/project\r");
    await submit(input, " \r");
    await submit(input, "\r");
    await submit(input, "ONE_TOKEN\r");
    await submit(input, "y\r"); // add another github service
    await submit(input, "\r"); // repo: same inferred default
    await submit(input, "TWO_TOKEN\r");
    await submit(input, "\r"); // done

    const result = await flow;
    strictEqual(result.status, "written");

    const config = await loadWorkbenchConfig(directory);
    strictEqual(config.services.length, 2);
    strictEqual(config.services[0].id, "github");
    strictEqual(config.services[0].repo, "example/project");
    strictEqual(config.services[1].id, "github-2");
    strictEqual(config.services[1].repo, "example/project");
  });
});
