#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || process.cwd());
const port = process.env.WORKBENCH_PORT || "4051";

const run = (file, args, cwd) => {
  const result = spawnSync(file, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// sync-data.mjs resolves the source root itself (WORKBENCH_SOURCE_ROOT ->
// superproject -> git toplevel -> cwd); running it from sourceRoot makes the
// cwd fallback correct for installed packages, where git detection may fail.
run(process.execPath, [join(appDirectory, "scripts/sync-data.mjs")], sourceRoot);

// `vp` is a native binary, so it must be spawned directly rather than through
// node; resolving it via vite-plus/package.json works under npm, pnpm, and yarn.
const require = createRequire(import.meta.url);
const vitePlusDirectory = dirname(require.resolve("vite-plus/package.json"));
const { bin } = JSON.parse(readFileSync(join(vitePlusDirectory, "package.json"), "utf8"));
const vp = join(vitePlusDirectory, typeof bin === "string" ? bin : bin.vp);

run(vp, ["fmt", "--write", join(appDirectory, "src/data.generated.ts")], appDirectory);
run(vp, ["dev", "--port", port, "--strictPort"], appDirectory);
