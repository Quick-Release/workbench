#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as p from "@clack/prompts";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || process.cwd());
const port = process.env.WORKBENCH_PORT || "4051";

const run = (file, args, cwd) => {
  const result = spawnSync(file, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const main = async () => {
  try {
    await runPipeline();
  } catch (cause) {
    // Health (#15): server-startup failures ride the next telemetry
    // payload before the process exits non-zero.
    const { recordHealthError } = await import("./scripts/telemetry.mjs");
    const version = JSON.parse(readFileSync(join(appDirectory, "package.json"), "utf8")).version;
    recordHealthError({ appDirectory, error: cause, version });
    throw cause;
  }
};

const runPipeline = async () => {
  // `init` scaffolds workbench.config.json interactively; every other invocation
  // takes the default pipeline, which must stay non-interactive (zero keystrokes).
  if (process.argv[2] === "init") {
    const { runInit } = await import("./scripts/init.mjs");
    const result = await runInit({ rootDirectory: sourceRoot });
    process.exitCode = result.status === "error" ? 1 : 0;
    return;
  }

  p.intro("workbench");
  const spinner = p.spinner();
  spinner.start("Syncing source data");

  // sync-data.mjs resolves the source root itself (WORKBENCH_SOURCE_ROOT ->
  // superproject -> git toplevel -> cwd); running it from sourceRoot makes the
  // cwd fallback correct for installed packages, where git detection may fail.
  const syncStatus = run(
    process.execPath,
    [join(appDirectory, "scripts/sync-data.mjs")],
    sourceRoot,
  );
  if (syncStatus !== 0) {
    spinner.error("Source data sync failed");
    process.exitCode = syncStatus;
    return;
  }
  spinner.stop("Source data synced");

  // `vp` is a native binary, so it must be spawned directly rather than through
  // node; resolving it via vite-plus/package.json works under npm, pnpm, and yarn.
  const require = createRequire(import.meta.url);
  const vitePlusDirectory = dirname(require.resolve("vite-plus/package.json"));
  const { bin } = JSON.parse(readFileSync(join(vitePlusDirectory, "package.json"), "utf8"));
  const vp = join(vitePlusDirectory, typeof bin === "string" ? bin : bin.vp);

  const formatStatus = run(
    vp,
    ["fmt", "--write", join(appDirectory, "src/data.generated.ts")],
    appDirectory,
  );
  if (formatStatus !== 0) {
    process.exitCode = formatStatus;
    return;
  }

  p.log.info(`Starting dev server on port ${port}`);
  // The Vite app lives inside the installed package, while setup actions must
  // mutate the host repository that this invocation is serving.
  process.env.WORKBENCH_SOURCE_ROOT = sourceRoot;
  const devStatus = run(vp, ["dev", "--port", port, "--strictPort"], appDirectory);
  if (devStatus !== 0) {
    process.exitCode = devStatus;
    return;
  }
  p.outro("workbench stopped");
};

await main();
