import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureHooksPath } from "./prepare.mjs";

const base = join(tmpdir(), "workbench-prepare");

const prepare = async (name, init = false) => {
  const directory = join(base, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  if (init) execFileSync("git", ["init", "-q", directory], { stdio: "ignore" });
  return directory;
};

test("enables the hook path inside a git repository", async () => {
  const directory = await prepare("enables", true);
  const result = ensureHooksPath({ directory, ci: false });
  strictEqual(result.enabled, true);
  strictEqual(
    execFileSync("git", ["-C", directory, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
    }).trim(),
    ".githooks",
  );
});

test("skips outside a git repository without failing", async () => {
  const directory = await prepare("skips");
  const result = ensureHooksPath({ directory, ci: false });
  strictEqual(result.enabled, false);
});

test("skips in CI even inside a git repository", async () => {
  const directory = await prepare("ci", true);
  const result = ensureHooksPath({ directory, ci: "1" });
  strictEqual(result.enabled, false);
});
