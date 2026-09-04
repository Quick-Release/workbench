import { strictEqual } from "node:assert";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { demoSourceRoot, resolveSourceRoot } from "./source-root.mjs";

const base = join(tmpdir(), "workbench-source-root");
const appDirectory = join(base, "checkout", "workbench");
const hostDirectory = join(base, "checkout");
const demoDirectory = join(base, "banquinha");
const fallbackDirectory = join(base, "elsewhere");

// demoDirectory is only passed when demo mode was requested (the dev:demo /
// sync:demo scripts set WORKBENCH_DEMO_SOURCE and sync-data checks existence).
const resolve = (overrides) =>
  resolveSourceRoot({
    appDirectory,
    configuredSourceRoot: "",
    superprojectDirectory: "",
    gitDirectory: "",
    demoDirectory: "",
    fallbackDirectory,
    fallbackGitDirectory: "",
    ...overrides,
  });

test("demo source defaults to the banquinha checkout", () => {
  strictEqual(demoSourceRoot("1").endsWith(join("workspaces", "getquick", "banquinha")), true);
  strictEqual(demoSourceRoot("true").endsWith(join("workspaces", "getquick", "banquinha")), true);
  strictEqual(demoSourceRoot("").endsWith(join("workspaces", "getquick", "banquinha")), true);
});

test("demo source request can name another checkout", () => {
  strictEqual(demoSourceRoot("/tmp/other-repo"), "/tmp/other-repo");
  strictEqual(demoSourceRoot("~/notes/repo"), join(homedir(), "notes/repo"));
});

test("reads an enclosing host repository and ignores requested demo data", () => {
  const result = resolve({ gitDirectory: hostDirectory, demoDirectory });
  strictEqual(result.rootDirectory, hostDirectory);
  strictEqual(result.usingDemoSource, false);
  strictEqual(result.usingSelfRepository, false);
});

test("treats a submodule superproject as the host repository", () => {
  const result = resolve({ superprojectDirectory: hostDirectory, gitDirectory: appDirectory });
  strictEqual(result.rootDirectory, hostDirectory);
  strictEqual(result.usingDemoSource, false);
  strictEqual(result.usingSelfRepository, false);
});

test("reads requested demo data in a standalone clone", () => {
  const result = resolve({ gitDirectory: appDirectory, demoDirectory });
  strictEqual(result.rootDirectory, demoDirectory);
  strictEqual(result.usingDemoSource, true);
  strictEqual(result.usingSelfRepository, false);
});

test("reads requested demo data outside any git repository", () => {
  const result = resolve({ demoDirectory });
  strictEqual(result.rootDirectory, demoDirectory);
  strictEqual(result.usingDemoSource, true);
  strictEqual(result.usingSelfRepository, false);
});

test("tracks this repository's own sources when demo is not requested", () => {
  const result = resolve({ gitDirectory: appDirectory });
  strictEqual(result.rootDirectory, appDirectory);
  strictEqual(result.usingDemoSource, false);
  strictEqual(result.usingSelfRepository, true);
});

test("keeps the working directory outside any repository without demo data", () => {
  const result = resolve({});
  strictEqual(result.rootDirectory, fallbackDirectory);
  strictEqual(result.usingDemoSource, false);
  strictEqual(result.usingSelfRepository, true);
});

test("uses the working directory repository when the package is outside its git tree", () => {
  const result = resolve({ fallbackGitDirectory: hostDirectory, demoDirectory });
  strictEqual(result.rootDirectory, hostDirectory);
  strictEqual(result.usingDemoSource, false);
  strictEqual(result.usingSelfRepository, false);
});

test("an explicit source root overrides the demo data", () => {
  const configuredSourceRoot = join(base, "pinned");
  const result = resolve({ configuredSourceRoot, gitDirectory: appDirectory, demoDirectory });
  strictEqual(result.rootDirectory, configuredSourceRoot);
  strictEqual(result.usingDemoSource, false);
  strictEqual(result.usingSelfRepository, false);
});
