import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  parseTriageMoveRequest,
  parseTriageMoveResult,
  parseWorkflowStatePayload,
} from "../src/schema.ts";
import { workflowStateFrom } from "../src/lib/workflow-state.ts";
import { deriveWorkItem } from "./tracker/labels.mjs";

const execFileAsync = promisify(execFile);

// The workbench app directory holds the generated snapshot; the host repo the
// server runs against is where gh commands execute, mirroring the other
// seam endpoints.
const APP_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORKFLOW_ROUTE = /^\/api\/workflow\/?$/;
const TRIAGE_ROUTE = /^\/api\/workflow\/triage\/?$/;

// The seam imports the generated snapshot module — its only syntax is the
// erasable kind (a type-only import and `satisfies`), so plain Node loads it.
// The mtime-keyed query re-imports after a re-sync instead of serving Node's
// module cache, so a fresh snapshot needs no dev-server restart.
let snapshotCache = null;

const importSnapshot = async (appDirectory) => {
  const path = join(appDirectory, "src", "data.generated.ts");
  const { mtimeMs } = await stat(path);
  if (snapshotCache && snapshotCache.path === path && snapshotCache.mtimeMs === mtimeMs)
    return snapshotCache.snapshot;
  const module = await import(`${pathToFileURL(path).href}?t=${mtimeMs}`);
  snapshotCache = { path, mtimeMs, snapshot: module.overviewData };
  return snapshotCache.snapshot;
};

export const loadWorkflowState = async (appDirectory = APP_DIRECTORY) => {
  const snapshot = await importSnapshot(appDirectory);
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.meta !== "object")
    throw new Error("snapshot file does not carry the overviewData literal");
  return workflowStateFrom(snapshot);
};

// ADR 0005: behind the seam run only the tools a Developer would run by hand.
const runGh = (command, args, cwd) => execFileAsync(command, args, { cwd, encoding: "utf8" });

const messageFrom = (error) =>
  String(error?.stderr ?? error?.message ?? error ?? "unexpected failure").trim();

// `gh issue view --json` reports the GraphQL state spelling (OPEN/CLOSED) and
// names the web url `url`; the tracker grammar expects the REST shapes.
const issueFromGhView = (payload) => ({
  number: payload.number,
  title: payload.title ?? "",
  body: payload.body ?? "",
  state: String(payload.state ?? "").toLocaleLowerCase() === "closed" ? "closed" : "open",
  html_url: payload.url ?? "",
  assignees: Array.isArray(payload.assignees) ? payload.assignees : [],
  labels: Array.isArray(payload.labels) ? payload.labels : [],
});

const byIssueNumber = (left, right) => Number(left.id.slice(3)) - Number(right.id.slice(3));

export const applyTriageMove = async ({ issueId, triageState, confirm, state, run, cwd }) => {
  if (triageState === "wontfix" && confirm !== true)
    return {
      ok: false,
      status: 422,
      message: `${issueId}: wontfix is a refusal — repeat the move with confirm to refuse it`,
    };
  const number = /^GH-(\d+)$/.exec(issueId)?.[1];
  if (!number)
    return {
      ok: false,
      status: 400,
      message: `"${issueId}" is not a tracker issue id; only GH-numbered items move here`,
    };
  const existing = state.workItems.find((item) => item.id === issueId);
  const current = existing?.triageState ?? "unlabeled";
  try {
    const args = ["issue", "edit", number, "--repo", state.meta.repo];
    if (triageState !== "unlabeled") args.push("--add-label", triageState);
    if (current !== "unlabeled" && current !== triageState) args.push("--remove-label", current);
    // A move out of the parked lane is an un-parking: deferred is parking,
    // not a triage state, so leaving it worn would keep the item parked
    // after its triage state moved.
    if (existing?.deferred) args.push("--remove-label", "deferred");
    await run("gh", args, cwd);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `gh label write failed for ${issueId}: ${messageFrom(error)}`,
    };
  }
  // Read the issue back through the same label grammar sync uses, so the
  // served state stays tracker-derived rather than drifting from it.
  let record;
  try {
    const readBack = await run(
      "gh",
      [
        "issue",
        "view",
        number,
        "--repo",
        state.meta.repo,
        "--json",
        "number,title,url,state,assignees,labels,body",
      ],
      cwd,
    );
    const { record: derived } = deriveWorkItem(issueFromGhView(JSON.parse(readBack.stdout)));
    record = derived;
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `label write succeeded but reading ${issueId} back failed: ${messageFrom(error)}`,
    };
  }
  const workItems = [...state.workItems.filter((item) => item.id !== record.id), record].sort(
    byIssueNumber,
  );
  return {
    ok: true,
    result: {
      message: `${issueId} moved to ${triageState}.`,
      issueId,
      triageState,
      state: { ...state, workItems },
    },
  };
};

// The seam handler behind the dev-server middleware: pure enough to test
// without vite, returning null for routes it does not own.
export const handleWorkflowApi = async ({
  method,
  pathname,
  body,
  appDirectory = APP_DIRECTORY,
  hostRoot = APP_DIRECTORY,
  run = runGh,
}) => {
  if (method === "GET" && WORKFLOW_ROUTE.test(pathname)) {
    try {
      return {
        status: 200,
        json: parseWorkflowStatePayload(await loadWorkflowState(appDirectory)),
      };
    } catch (error) {
      return {
        status: 500,
        json: {
          message: `workflow state unavailable (${messageFrom(error)}); the dashboard falls back to its bundled snapshot`,
        },
      };
    }
  }

  if (method === "POST" && TRIAGE_ROUTE.test(pathname)) {
    let raw;
    try {
      raw = JSON.parse(body ?? "");
    } catch {
      return { status: 400, json: { message: "request body is not valid JSON" } };
    }
    let request;
    try {
      request = parseTriageMoveRequest(raw);
    } catch (error) {
      return { status: 400, json: { message: messageFrom(error) } };
    }
    let state;
    try {
      state = parseWorkflowStatePayload(await loadWorkflowState(appDirectory));
    } catch (error) {
      return {
        status: 500,
        json: {
          message: `workflow state unavailable (${messageFrom(error)}); run pnpm sync and retry`,
        },
      };
    }
    const outcome = await applyTriageMove({ ...request, state, run, cwd: hostRoot });
    if (!outcome.ok) return { status: outcome.status, json: { message: outcome.message } };
    return { status: 200, json: parseTriageMoveResult(outcome.result) };
  }

  return null;
};

const readBody = (request) =>
  new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });

export const workflowApiPlugin = () => ({
  name: "workbench-workflow-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!WORKFLOW_ROUTE.test(url.pathname) && !TRIAGE_ROUTE.test(url.pathname)) return next();
      const hostRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
      const body = request.method === "POST" ? await readBody(request) : undefined;
      const handled = await handleWorkflowApi({
        method: request.method,
        pathname: url.pathname,
        body,
        hostRoot,
      });
      if (!handled) return next();
      response.statusCode = handled.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handled.json));
    });
  },
});
