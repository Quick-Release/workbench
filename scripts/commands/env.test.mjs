import { strictEqual } from "node:assert";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureEnvFile } from "./env.mjs";

const base = join(tmpdir(), "workbench-env");

const prepare = async (name, files = {}) => {
  const directory = join(base, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const [fileName, contents] of Object.entries(files)) {
    await writeFile(join(directory, fileName), contents);
  }
  return directory;
};

test("creates .env from .env.example when .env is missing", async () => {
  const directory = await prepare("creates", { ".env.example": "GITHUB_TOKEN=abc\n" });
  const result = await ensureEnvFile({ directory });
  strictEqual(result.created, true);
  strictEqual(await readFile(join(directory, ".env"), "utf8"), "GITHUB_TOKEN=abc\n");
});

test("never overwrites an existing .env", async () => {
  const directory = await prepare("keeps", {
    ".env.example": "GITHUB_TOKEN=abc\n",
    ".env": "GITHUB_TOKEN=mine\n",
  });
  const result = await ensureEnvFile({ directory });
  strictEqual(result.created, false);
  strictEqual(await readFile(join(directory, ".env"), "utf8"), "GITHUB_TOKEN=mine\n");
});

test("stays quiet when no .env.example exists", async () => {
  const directory = await prepare("empty");
  const result = await ensureEnvFile({ directory });
  strictEqual(result.created, false);
  strictEqual(await readFile(join(directory, ".env"), "utf8").catch(() => "absent"), "absent");
});

test("names are overridable for the demo file shape", async () => {
  const directory = await prepare("names", { ".env.example": "WORKBENCH_DEMO_SOURCE=1\n" });
  const result = await ensureEnvFile({ directory, envName: ".env.local" });
  strictEqual(result.created, true);
  strictEqual(await readFile(join(directory, ".env.local"), "utf8"), "WORKBENCH_DEMO_SOURCE=1\n");
});
