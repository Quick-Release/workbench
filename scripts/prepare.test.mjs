import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { envWithoutGitContext } from "./git-context.mjs";
import { ensureHooksPath } from "./prepare.mjs";

const base = join(tmpdir(), "workbench-prepare");

const prepare = async (name, init = false) => {
  const directory = join(base, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  if (init) {
    execFileSync("git", ["init", "-q", directory], {
      stdio: "ignore",
      env: envWithoutGitContext(),
    });
  }
  return directory;
};

test("enables the hook path inside a git repository", async () => {
  const directory = await prepare("enables", true);
  const result = ensureHooksPath({ directory, ci: false });
  strictEqual(result.enabled, true);
  strictEqual(result.reason, undefined);
  strictEqual(
    execFileSync("git", ["-C", directory, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
      env: envWithoutGitContext(),
    }).trim(),
    ".githooks",
  );
});

test("skips outside a git repository without failing", async () => {
  const directory = await prepare("skips");
  const result = ensureHooksPath({ directory, ci: false });
  strictEqual(result.enabled, false);
  strictEqual(result.reason, "no-repo");
});

test("inherited git context does not turn a plain directory into a repository", async () => {
  // A pre-commit hook exports GIT_DIR and friends to everything it spawns,
  // this suite included. The probe targets the directory it is given and must
  // not mistake the caller's repo for the probed one — or worse, point the
  // caller's core.hooksPath at workbench.
  const foreign = await prepare("context-foreign", true);
  const directory = await prepare("context-plain");
  const inherited = {
    GIT_DIR: join(foreign, ".git"),
    GIT_WORK_TREE: foreign,
    GIT_INDEX_FILE: join(foreign, ".git", "index"),
  };
  const saved = new Map(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  try {
    const result = ensureHooksPath({ directory, ci: false });
    strictEqual(result.enabled, false);
    strictEqual(result.reason, "no-repo");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("skips in CI even inside a git repository", async () => {
  const directory = await prepare("ci", true);
  const result = ensureHooksPath({ directory, ci: "1" });
  strictEqual(result.enabled, false);
  strictEqual(result.reason, "ci");
});
