import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  parseEdgeAddRequest,
  parseEdgeRemoveRequest,
  parseEdgeWriteResult,
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
  parseClosedClientTickets,
} from "../src/schema.ts";
import { workflowStateFrom } from "../src/lib/workflow-state.ts";
import { byIssueNumber, workItemIdNumber } from "../src/lib/work-item-id.ts";
import { deriveWorkItem } from "./tracker/labels.mjs";
import { ghIssueRecord } from "./tracker/gh-view.mjs";
import { collectClientTickets } from "./tracker/client-tickets.mjs";
import { tokenFromGhCli } from "./tracker/index.mjs";
import { GITHUB_API } from "./tracker/issues.mjs";
import { guardedApi, sendJson } from "./api-shared.mjs";
import { createAutoSync } from "./auto-sync.mjs";

const execFileAsync = promisify(execFile);

// The workbench app directory holds the generated snapshot; the host repo the
// server runs against is where gh commands execute, mirroring the other
// seam endpoints.
const APP_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORKFLOW_ROUTE = /^\/api\/workflow\/?$/;
const CLIENT_CLOSED_ROUTE = /^\/api\/client-tickets\/closed\/?$/;
const TRIAGE_ROUTE = /^\/api\/workflow\/triage\/?$/;
const ISSUE_EDIT_ROUTE = /^\/api\/workflow\/issue\/edit\/?$/;
const ISSUE_COMMENT_ROUTE = /^\/api\/workflow\/issue\/comment\/?$/;
const ISSUE_CREATE_ROUTE = /^\/api\/workflow\/issue\/create\/?$/;
const SYNC_ROUTE = /^\/api\/workflow\/sync\/?$/;
const EDGE_ADD_ROUTE = /^\/api\/workflow\/edge\/add\/?$/;
const EDGE_REMOVE_ROUTE = /^\/api\/workflow\/edge\/remove\/?$/;

// The seam imports the generated snapshot module — its only syntax is the
// erasable kind (a type-only import and `satisfies`), so plain Node loads it.
// The mtime-keyed query re-imports after a re-sync instead of serving Node's
// module cache, so a fresh snapshot needs no dev-server restart. The module
// also carries the sync warnings channel, read structurally instead of
// scraped from the sync output's console copy.
let snapshotCache = null;

const importSnapshot = async (appDirectory) => {
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
  const { snapshot, warnings } = await importSnapshot(appDirectory);
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.meta !== "object")
    throw new Error("snapshot file does not carry the overviewData literal");
  // GH-145: the warnings channel rides the served payload, so the dashboard
  // sees what sync saw instead of scraping the console.
  return workflowStateFrom(snapshot, warnings);
};

// ADR 0005: behind the seam run only the tools a Developer would run by hand.
const runGh = (command, args, cwd) => execFileAsync(command, args, { cwd, encoding: "utf8" });

const messageFrom = (error) =>
  String(error?.stderr ?? error?.message ?? error ?? "unexpected failure").trim();

const issueNumberFrom = (issueId) => /^GH-(\d+)$/.exec(issueId)?.[1];

// Read the issue back through the same label grammar sync uses, so the
// served state stays tracker-derived rather than drifting from it. A write
// that succeeded but cannot be read back is a 502, not silence.
const readIssueRecord = async (number, state, run, cwd) =>
  ghIssueRecord({
    issue: number,
    repo: state.meta.repo,
    run: (args) => run("gh", args, cwd),
  });

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

// The blocker-edge actions (ticket #61, ADR 0005 phase-1): behind the seam
// they run exactly what a Developer would run by hand — the native
// blocked-by API through `gh api`, which speaks database ids, so every write
// first resolves the blocker's id, then posts or deletes the gate, then
// reads the issue's blocked-by list back so the served edges stay
// tracker-derived. Native blocked-by only speaks tracker issues; adding is
// additive, removal is destructive and demands the confirmed beat.
const trackerIssueNumber = (issueId) => {
  const number = issueNumberFrom(issueId);
  return number && number > 0 ? number : null;
};

const resolveBlockerDatabaseId = async (blockerId, number, state, run, cwd) => {
  const resolved = await run(
    "gh",
    ["api", `repos/${state.meta.repo}/issues/${number}`, "--jq", ".id"],
    cwd,
  );
  const databaseId = Number(String(resolved.stdout).trim());
  if (!Number.isInteger(databaseId) || databaseId <= 0)
    throw new Error(`gh did not answer ${blockerId}'s database id with a number`);
  return databaseId;
};

const readBackBlockedBy = async (issueId, number, state, run, cwd) => {
  const readBack = await run(
    "gh",
    ["api", `repos/${state.meta.repo}/issues/${number}/dependencies/blocked_by?per_page=100`],
    cwd,
  );
  const blockers = JSON.parse(readBack.stdout);
  if (!Array.isArray(blockers))
    throw new Error(`the blocked-by read-back for ${issueId} was not a list`);
  const record = state.workItems.find((item) => item.id === issueId);
  const sourceRef = record?.url ?? `https://github.com/${state.meta.repo}/issues/${number}`;
  return blockers
    .filter((blocker) => blocker && typeof blocker.number === "number")
    .map((blocker) => ({
      blockedId: issueId,
      blockerId: `GH-${blocker.number}`,
      source: "github-native",
      sourceRef,
    }));
};

const withRefreshedEdges = (state, blockedId, freshNativeEdges) => {
  const surviving = state.blockerEdges.filter(
    (edge) => !(edge.blockedId === blockedId && edge.source === "github-native"),
  );
  const edges = [...surviving, ...freshNativeEdges];
  edges.sort((left, right) => {
    const order = (edge) => workItemIdNumber(edge.blockedId);
    const blockerOrder = (edge) => workItemIdNumber(edge.blockerId);
    return (
      order(left) - order(right) ||
      blockerOrder(left) - blockerOrder(right) ||
      left.source.localeCompare(right.source)
    );
  });
  return { ...state, blockerEdges: edges };
};

// One skeleton behind both edge actions: resolve the blocker's database id,
// issue the native call (POST to add the gate, DELETE to remove it), read
// the blocked issue's blocked-by list back, and serve the refreshed edges.
// `verb` only shapes the failure wording.
const applyEdgeWrite = async ({ blockedId, blockerId, method, verb, state, run, cwd }) => {
  const blockedNumber = trackerIssueNumber(blockedId);
  const blockerNumber = trackerIssueNumber(blockerId);
  if (!blockedNumber || !blockerNumber)
    return {
      ok: false,
      status: 400,
      message:
        "native blocked-by only speaks tracker issues — declare the gate with GH-numbered ids",
    };
  let databaseId;
  try {
    databaseId = await resolveBlockerDatabaseId(blockerId, blockerNumber, state, run, cwd);
    await run(
      "gh",
      [
        "api",
        "--method",
        method,
        method === "DELETE"
          ? `repos/${state.meta.repo}/issues/${blockedNumber}/dependencies/blocked_by/${databaseId}`
          : `repos/${state.meta.repo}/issues/${blockedNumber}/dependencies/blocked_by?per_page=100`,
        ...(method === "POST" ? ["-F", `issue_id=${databaseId}`] : []),
      ],
      cwd,
    );
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `gh edge ${verb} failed for ${blockedId} ← ${blockerId}: ${messageFrom(error)}`,
    };
  }
  let freshEdges;
  try {
    freshEdges = await readBackBlockedBy(blockedId, blockedNumber, state, run, cwd);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      message: `the edge ${verb} succeeded but reading ${blockedId}'s blockers back failed: ${messageFrom(error)}`,
    };
  }
  return {
    ok: true,
    result: { blockedId, blockerId, state: withRefreshedEdges(state, blockedId, freshEdges) },
  };
};

export const applyEdgeAdd = async ({ blockedId, blockerId, state, run, cwd }) => {
  if (blockedId === blockerId)
    return {
      ok: false,
      status: 400,
      message: `${blockedId} cannot block itself — a self-edge gates nothing`,
    };
  const outcome = await applyEdgeWrite({
    blockedId,
    blockerId,
    method: "POST",
    verb: "write",
    state,
    run,
    cwd,
  });
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    result: { ...outcome.result, message: `${blockedId} is now blocked by ${blockerId}.` },
  };
};

export const applyEdgeRemove = async ({ blockedId, blockerId, confirm, state, run, cwd }) => {
  if (confirm !== true)
    return {
      ok: false,
      status: 422,
      message: `${blockedId} ← ${blockerId}: removing a gate is destructive — repeat the removal with confirm to tear it off`,
    };
  const outcome = await applyEdgeWrite({
    blockedId,
    blockerId,
    method: "DELETE",
    verb: "removal",
    state,
    run,
    cwd,
  });
  if (!outcome.ok) return outcome;
  return {
    ok: true,
    result: { ...outcome.result, message: `${blockerId} no longer blocks ${blockedId}.` },
  };
};

// The sync trigger (ticket #64) runs what a Developer would run by hand —
// `pnpm sync` in the app directory, whose script resolves the host repo —
// then serves the refreshed state with the sync warnings channel (cycles,
// dangling edges, unparsable statuses, missing linkage), read structurally
// from the regenerated snapshot module.
export const applySyncTrigger = async ({ appDirectory, run }) => {
  try {
    await run("pnpm", ["sync"], appDirectory);
  } catch (error) {
    return { ok: false, status: 502, message: `pnpm sync failed: ${messageFrom(error)}` };
  }
  let state;
  let warnings;
  try {
    // The mtime cache makes the second import free; loadWorkflowState owns
    // the snapshot-shape guard so it cannot drift from the GET read.
    warnings = (await importSnapshot(appDirectory)).warnings;
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
  {
    route: EDGE_ADD_ROUTE,
    parseRequest: parseEdgeAddRequest,
    encode: parseEdgeWriteResult,
    apply: applyEdgeAdd,
  },
  {
    route: EDGE_REMOVE_ROUTE,
    parseRequest: parseEdgeRemoveRequest,
    encode: parseEdgeWriteResult,
    apply: applyEdgeRemove,
  },
];

// The seam handler behind the dev-server middleware: pure enough to test
// without vite, returning null for routes it does not own. `fetchImpl`
// overrides the GitHub reads (the closed lens) in tests; `env`/`ghToken`
// mirror the tracker collector's credential injection. `onSeamRead` observes
// the reads the auto-sync leg counts as browser presence (GH-147): a GET the
// handler owns — the polling live read or the closed lens — is a browser
// reading the seam right now.
export const handleWorkflowApi = async ({
  method,
  pathname,
  body,
  appDirectory = APP_DIRECTORY,
  hostRoot = APP_DIRECTORY,
  run = runGh,
  fetchImpl,
  env = process.env,
  ghToken = tokenFromGhCli,
  onSeamRead,
}) => {
  if (method === "GET" && (WORKFLOW_ROUTE.test(pathname) || CLIENT_CLOSED_ROUTE.test(pathname)))
    onSeamRead?.(pathname);

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

  if (method === "GET" && CLIENT_CLOSED_ROUTE.test(pathname)) {
    // The closed lens (GH-136): a bounded, label-specific history read — one
    // page per client label, most recently updated first — so the open
    // snapshot never has to pretend it contains closed history. Coverage
    // rides the answer; a failed or capped read is a visible warning, and a
    // missing token is a typed 503, never an empty "no tickets".
    try {
      const state = parseWorkflowStatePayload(await loadWorkflowState(appDirectory));
      const fromEnv = typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "";
      const token = fromEnv || (await ghToken());
      if (!token)
        return {
          status: 503,
          json: {
            message:
              "closed client tickets unavailable: missing GITHUB_TOKEN (set it, or authenticate the gh CLI)",
          },
        };
      const pass = await collectClientTickets({
        repo: state.meta.repo,
        token,
        apiBase: GITHUB_API,
        fetchImpl: fetchImpl ?? globalThis.fetch,
        maxPages: 1,
        state: "closed",
        sort: "updated",
      });
      const tickets = pass.issues
        .map((issue) => deriveWorkItem(issue).record)
        .sort((left, right) => workItemIdNumber(right.id) - workItemIdNumber(left.id));
      return {
        status: 200,
        json: parseClosedClientTickets({ tickets, coverage: pass.coverage }),
      };
    } catch (error) {
      return {
        status: 502,
        json: {
          message: `closed client tickets unavailable (${messageFrom(error)}); the closed lens stays empty rather than guessing`,
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
  CLIENT_CLOSED_ROUTE.test(pathname) ||
  SYNC_ROUTE.test(pathname) ||
  POST_ROUTES.some((action) => action.route.test(pathname));

// The generated snapshot is written under the dashboard's src/ by every sync
// (manual or auto-sync). Verified live (GH-147): vite has no accepted HMR
// boundary for it, so a rewrite bubbles to a full page reload. The watcher
// must not see it — the client polling lifecycle is the only refresh path a
// sync may take, or every auto-sync would hard-reload the open board.
const SNAPSHOT_WATCH_IGNORE = "**/src/data.generated.ts";

export const workflowApiPlugin = () => ({
  name: "workbench-workflow-api",
  config: () => ({
    server: { watch: { ignored: [SNAPSHOT_WATCH_IGNORE] } },
  }),
  configureServer(server) {
    // The auto-sync leg (GH-147) reuses the sync-trigger action end to end,
    // so a tick's sync carries the same warnings channel, freshness stamp,
    // and telemetry as a manual Run sync. The repo name resolves at tick
    // time — the same mtime-cached read the GET route serves from. The leg
    // lives per server (not per plugin factory): vite restarts create the
    // new server before closing the old one, and a shared leg would let the
    // old server's close cancel the new one's timer.
    const autoSync = createAutoSync({
      appDirectory: APP_DIRECTORY,
      resolveRepo: async () => {
        const state = await loadWorkflowState(APP_DIRECTORY);
        return state.meta.repo;
      },
      applySync: applySyncTrigger,
      run: runGh,
      ghToken: tokenFromGhCli,
    });
    autoSync.start();
    server.httpServer?.once("close", () => autoSync.stop());
    server.middlewares.use(
      guardedApi(async (request, response, next, url) => {
        if (!isWorkflowRoute(url.pathname)) return next();
        const hostRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
        const body = request.method === "POST" ? await readBody(request) : undefined;
        const handled = await handleWorkflowApi({
          method: request.method,
          pathname: url.pathname,
          body,
          hostRoot,
          onSeamRead: () => autoSync.noteSeamRead(),
        });
        if (!handled) return next();
        sendJson(response, handled.status, handled.json);
      }),
    );
  },
});
