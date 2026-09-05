import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  parseIssueCommentRequest,
  parseIssueCommentResult,
  parseIssueCreateRequest,
  parseIssueCreateResult,
  parseIssueEditRequest,
  parseIssueEditResult,
  parseSyncTriggerRequest,
  parseSyncTriggerResult,
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
const ISSUE_EDIT_ROUTE = /^\/api\/workflow\/issue\/edit\/?$/;
const ISSUE_COMMENT_ROUTE = /^\/api\/workflow\/issue\/comment\/?$/;
const ISSUE_CREATE_ROUTE = /^\/api\/workflow\/issue\/create\/?$/;
const SYNC_ROUTE = /^\/api\/workflow\/sync\/?$/;

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

const issueNumberFrom = (issueId) => /^GH-(\d+)$/.exec(issueId)?.[1];

// Read the issue back through the same label grammar sync uses, so the
// served state stays tracker-derived rather than drifting from it. A write
// that succeeded but cannot be read back is a 502, not silence.
const readIssueRecord = async (number, state, run, cwd) => {
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
  return derived;
};

const readBackOrFail = async (issueId, number, state, run, cwd, verb) => {
  try {
    return { record: await readIssueRecord(number, state, run, cwd) };
  } catch (error) {
    return {
      failure: {
        ok: false,
        status: 502,
        message: `${verb} succeeded but reading ${issueId} back failed: ${messageFrom(error)}`,
      },
    };
  }
};

const upsertRecord = (state, record) => ({
  ...state,
  workItems: [...state.workItems.filter((item) => item.id !== record.id), record].sort(
    byIssueNumber,
  ),
});

export const applyTriageMove = async ({ issueId, triageState, confirm, state, run, cwd }) => {
  if (triageState === "wontfix" && confirm !== true)
    return {
      ok: false,
      status: 422,
      message: `${issueId}: wontfix is a refusal — repeat the move with confirm to refuse it`,
    };
  const number = issueNumberFrom(issueId);
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
  const back = await readBackOrFail(issueId, number, state, run, cwd, "label write");
  if (back.failure) return back.failure;
  return {
    ok: true,
    result: {
      message: `${issueId} moved to ${triageState}.`,
      issueId,
      triageState,
      state: upsertRecord(state, back.record),
    },
  };
};

// ADR 0005 phase-1 issue actions (ticket #60): an edit overwrites the
// issue's title or body, so it moves only with `confirm: true` — the seam
// enforces the deliberate beat the dashboard renders.
export const applyIssueEdit = async ({ issueId, title, body, confirm, state, run, cwd }) => {
  if (confirm !== true)
    return {
      ok: false,
      status: 422,
      message: `${issueId}: editing overwrites the issue — repeat the edit with confirm to save it`,
    };
  if (!title && !body)
    return {
      ok: false,
      status: 400,
      message: `${issueId}: nothing to edit — pass a title or a body`,
    };
  const number = issueNumberFrom(issueId);
  if (!number)
    return {
      ok: false,
      status: 400,
      message: `"${issueId}" is not a tracker issue id; only GH-numbered items edit here`,
    };
  try {
    const args = ["issue", "edit", number, "--repo", state.meta.repo];
    if (title) args.push("--title", title);
    if (body) args.push("--body", body);
    await run("gh", args, cwd);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `gh issue edit failed for ${issueId}: ${messageFrom(error)}`,
    };
  }
  const back = await readBackOrFail(issueId, number, state, run, cwd, "edit");
  if (back.failure) return back.failure;
  return {
    ok: true,
    result: { message: `${issueId} updated.`, issueId, state: upsertRecord(state, back.record) },
  };
};

// ADR 0005 phase-1 issue actions (ticket #60): commenting is additive, so it
// fires directly — `gh` answers with the new comment's url.
export const applyIssueComment = async ({ issueId, body, state, run, cwd }) => {
  if (!body.trim())
    return {
      ok: false,
      status: 400,
      message: "an empty comment is not worth a write — say something first",
    };
  const number = issueNumberFrom(issueId);
  if (!number)
    return {
      ok: false,
      status: 400,
      message: `"${issueId}" is not a tracker issue id; only GH-numbered items take comments here`,
    };
  try {
    const written = await run(
      "gh",
      ["issue", "comment", number, "--repo", state.meta.repo, "--body", body],
      cwd,
    );
    return {
      ok: true,
      result: {
        message: `Commented on ${issueId}.`,
        issueId,
        commentUrl: written.stdout.trim(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `gh issue comment failed for ${issueId}: ${messageFrom(error)}`,
    };
  }
};

// Creating is additive like commenting; `gh` answers with the new issue's
// url, and the created issue is read back so the served state stays
// tracker-derived.
export const applyIssueCreate = async ({ title, body, state, run, cwd }) => {
  try {
    const args = ["issue", "create", "--repo", state.meta.repo, "--title", title];
    if (body) args.push("--body", body);
    const created = await run("gh", args, cwd);
    const number = /\/issues\/(\d+)/.exec(created.stdout)?.[1];
    if (!number)
      return {
        ok: false,
        status: 502,
        message: `gh issue create did not name the new issue's url: ${created.stdout.trim()}`,
      };
    const record = await readIssueRecord(number, state, run, cwd);
    return {
      ok: true,
      result: {
        message: `${record.id} created.`,
        issueId: record.id,
        state: upsertRecord(state, record),
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `gh issue create failed: ${messageFrom(error)}`,
    };
  }
};

// The sync trigger (ticket #64) runs what a Developer would run by hand —
// `pnpm sync` in the app directory, whose script resolves the host repo —
// then serves the refreshed state with the sync output's warnings channel
// (cycles, dangling edges, unparsable statuses, missing linkage).
const warningsFromSyncOutput = (stdout) => {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => /^Tracker warnings \(\d+\):/.test(line.trim()));
  if (start === -1) return [];
  const warnings = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+(.*)$/.exec(line);
    if (!match) break;
    warnings.push(match[1]);
  }
  return warnings;
};

export const applySyncTrigger = async ({ appDirectory, run }) => {
  let outcome;
  try {
    outcome = await run("pnpm", ["sync"], appDirectory);
  } catch (error) {
    return { ok: false, status: 502, message: `pnpm sync failed: ${messageFrom(error)}` };
  }
  const warnings = warningsFromSyncOutput(String(outcome?.stdout ?? ""));
  let state;
  try {
    state = parseWorkflowStatePayload(await loadWorkflowState(appDirectory));
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `sync ran but reading the refreshed state failed: ${messageFrom(error)}`,
    };
  }
  return {
    ok: true,
    result: {
      message:
        warnings.length > 0
          ? `Synced with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
          : "Synced, no warnings.",
      warnings,
      state,
    },
  };
};

// Shared POST plumbing for the seam's actions: decode the request through
// its schema, load the joined state, apply, and encode the result back
// through its schema — everything crossing the seam passes both directions.
const handleWorkflowAction = async ({
  body,
  parseRequest,
  encode,
  apply,
  appDirectory,
  hostRoot,
  run,
}) => {
  let raw;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    return { status: 400, json: { message: "request body is not valid JSON" } };
  }
  let request;
  try {
    request = parseRequest(raw);
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
  const outcome = await apply({ ...request, state, run, cwd: hostRoot });
  if (!outcome.ok) return { status: outcome.status, json: { message: outcome.message } };
  return { status: 200, json: encode(outcome.result) };
};

const POST_ROUTES = [
  {
    route: TRIAGE_ROUTE,
    parseRequest: parseTriageMoveRequest,
    encode: parseTriageMoveResult,
    apply: applyTriageMove,
  },
  {
    route: ISSUE_EDIT_ROUTE,
    parseRequest: parseIssueEditRequest,
    encode: parseIssueEditResult,
    apply: applyIssueEdit,
  },
  {
    route: ISSUE_COMMENT_ROUTE,
    parseRequest: parseIssueCommentRequest,
    encode: parseIssueCommentResult,
    apply: applyIssueComment,
  },
  {
    route: ISSUE_CREATE_ROUTE,
    parseRequest: parseIssueCreateRequest,
    encode: parseIssueCreateResult,
    apply: applyIssueCreate,
  },
];

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

  if (method === "POST" && SYNC_ROUTE.test(pathname)) {
    // A sync request takes no fields; Effect's excess-property check has no
    // keys to compare against on an empty struct, so the schema decode is
    // backed by a no-fields check the schema alone cannot express.
    let raw;
    try {
      raw = JSON.parse(body ?? "");
    } catch {
      return { status: 400, json: { message: "request body is not valid JSON" } };
    }
    try {
      parseSyncTriggerRequest(raw);
    } catch (error) {
      return { status: 400, json: { message: messageFrom(error) } };
    }
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).length > 0
    )
      return { status: 400, json: { message: "a sync request takes no fields" } };
    const outcome = await applySyncTrigger({ appDirectory, run });
    if (!outcome.ok) return { status: outcome.status, json: { message: outcome.message } };
    return { status: 200, json: parseSyncTriggerResult(outcome.result) };
  }

  if (method === "POST") {
    for (const action of POST_ROUTES) {
      if (!action.route.test(pathname)) continue;
      return handleWorkflowAction({ ...action, body, appDirectory, hostRoot, run });
    }
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

const isWorkflowRoute = (pathname) =>
  WORKFLOW_ROUTE.test(pathname) ||
  SYNC_ROUTE.test(pathname) ||
  POST_ROUTES.some((action) => action.route.test(pathname));

export const workflowApiPlugin = () => ({
  name: "workbench-workflow-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!isWorkflowRoute(url.pathname)) return next();
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
