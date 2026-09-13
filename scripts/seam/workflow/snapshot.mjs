import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { workflowStateFrom } from "../../../src/lib/workflow-state.ts";

// The package directory holds the generated snapshot. Keep this seam shared by
// workflow and review routes so their default path cannot drift independently.
export const APP_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The mtime-keyed import re-reads the generated module after a sync without a
// dev-server restart. The warnings channel is kept alongside the snapshot so
// callers do not have to scrape sync's console output.
let snapshotCache = null;

export const importWorkflowSnapshot = async (appDirectory) => {
  const path = join(appDirectory, "src", "data.generated.ts");
  const { mtimeMs } = await stat(path);
  if (snapshotCache && snapshotCache.path === path && snapshotCache.mtimeMs === mtimeMs)
    return snapshotCache;
  const module = await import(`${pathToFileURL(path).href}?t=${mtimeMs}`);
  snapshotCache = {
    path,
    mtimeMs,
    snapshot: module.overviewData,
    // A generated module from an older workbench carries no warnings export.
    warnings: Array.isArray(module.syncWarnings) ? module.syncWarnings : [],
  };
  return snapshotCache;
};

export const loadWorkflowState = async (appDirectory = APP_DIRECTORY) => {
  const { snapshot, warnings } = await importWorkflowSnapshot(appDirectory);
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.meta !== "object")
    throw new Error("snapshot file does not carry the overviewData literal");
  return workflowStateFrom(snapshot, warnings);
};
