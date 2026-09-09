import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  parseReviewCancelRequest,
  parseReviewHealth,
  parseReviewHistory,
  parseReviewRunRequest,
} from "../src/schema.ts";
import { guardedApi, methodMismatch, readBody, sendJson } from "./api-shared.mjs";
import { ghPullRequestLoader } from "./ai-sources.mjs";
import { gateRejection } from "./request-gate.mjs";
import { createRunRegistry, reviewHealth, startReviewRun } from "./review-runner.mjs";
import { reviewRunOutcome } from "../src/lib/review-run-state.ts";

// The review API middleware (epic #20): the localhost seam the dashboard's
// PR page drives — the engines' health (ticket #24), the review runs
// (ticket #26), and the session history of finished runs (ticket #27). The
// handlers are pure — request parts in, a response part out, the answers
// through the Effect Schema — and the runner is injected, so tests stub it
// and no live CLI is ever touched.

const HEALTH_ROUTE = /^\/api\/review\/health\/?$/;
const RUN_ROUTE = /^\/api\/review\/?$/;
const CANCEL_ROUTE = /^\/api\/review\/cancel\/?$/;
const HISTORY_ROUTE = /^\/api\/review\/history\/?$/;

export const isReviewApiRoute = (pathname) =>
  HEALTH_ROUTE.test(pathname) ||
  RUN_ROUTE.test(pathname) ||
  CANCEL_ROUTE.test(pathname) ||
  HISTORY_ROUTE.test(pathname);

// The session run history (ticket #27): what the dev-server remembers about
// the runs it has already finished. In-memory and per-server — a restart
// resets it by design, consistent with workbench's local-first posture. The
// list answers newest first, so the panel reads like a history.
export const createRunHistory = () => {
  let nextId = 1;
  const runs = [];
  return {
    record(entry) {
      runs.push({ id: nextId++, ...entry });
    },
    list() {
      return [...runs].reverse();
    },
  };
};

export const handleReviewHistory = ({ method, pathname, host, origin, history }) => {
  if (!HISTORY_ROUTE.test(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");

  return { status: 200, json: parseReviewHistory({ runs: history.list() }) };
};

export const handleReviewApi = async ({ method, pathname, host, origin, probeHealth }) => {
  if (!isReviewApiRoute(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "GET") return methodMismatch("GET");

  try {
    return { status: 200, json: parseReviewHealth(await probeHealth()) };
  } catch (error) {
    return {
      status: 500,
      json: { error: "probe_failed", message: String(error?.message ?? error) },
    };
  }
};

// The run target is resolved server-side with the host repo's own gh — the
// PR's base branch comes from the same CLI a Developer would run by hand
// (ADR 0005), and only the PR number is accepted from the page (epic #20:
// the command surface is enumerated).
export const ghReviewTarget =
  ({ loadPullRequest = ghPullRequestLoader(), hostRoot } = {}) =>
  async ({ pr }) => {
    try {
      const record = await loadPullRequest(pr);
      return { baseBranch: record.base, hostRepoRoot: hostRoot };
    } catch (error) {
      // gh saying the PR does not exist is an answer; every other failure
      // (auth, network) must not masquerade as "unknown PR".
      if (/could not resolve|not found|no pull request/i.test(String(error?.stderr ?? error))) {
        return null;
      }
      throw error;
    }
  };

// The issue agent's target (issue #40): the worktree forks the default
// branch, resolved locally from the remote-tracking HEAD the same way a
// Developer's `git` would answer. An explicit base branch from the page
// (already validated as a plain ref) is trusted instead — no git call, no
// surprise. An unknown issue number is not screened here: the agent reads
// the issue itself and reports what it finds; the draft PR is the gate.
export const ghIssueTarget =
  ({ hostRoot, runGit = defaultGitRunner } = {}) =>
  async ({ issue, baseBranch }) => {
    if (baseBranch) return { hostRepoRoot: hostRoot, baseBranch };
    const result = runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], hostRoot);
    if (result.status !== 0) {
      throw new Error(
        (result.stderr ?? "").trim() ||
          `could not resolve the default branch of ${hostRoot} for issue #${issue}`,
      );
    }
    return { hostRepoRoot: hostRoot, baseBranch: result.stdout.trim() };
  };

const defaultGitRunner = (args, cwd) =>
  spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5_000 });

const busyRejection = (engine) => ({
  status: 409,
  json: {
    error: "run_busy",
    engine,
    message: `a ${engine} review is already running; cancel it or wait for it to finish`,
  },
});

export const handleReviewRunStart = async ({
  body,
  host,
  origin,
  startRun,
  registry,
  history = createRunHistory(),
  resolveTarget,
}) => {
  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  let request;
  try {
    request = parseReviewRunRequest(body);
  } catch (error) {
    // Missing fields get the friendly summary; a present-but-invalid field
    // (fractional PR, both targets, a bad model) keeps the schema's specific
    // reason — a generic "engine and target are required" would misdescribe
    // what actually failed.
    const reason = String(error?.message ?? error);
    const specific = /must be a positive integer|exactly one of|model must be|branch name/.test(
      reason,
    );
    return {
      status: 400,
      json: {
        error: "invalid_request",
        message: specific ? reason : "engine, and a pr or issue number, are required",
      },
    };
  }

  // Single-run per engine (ticket #26): the engine is claimed before the
  // target resolves or anything spawns, so two concurrent starts cannot both
  // reach a CLI — the loser gets the typed busy rejection.
  if (!registry.claim(request.engine)) return busyRejection(request.engine);

  let target;
  try {
    target = await resolveTarget(request);
  } catch (error) {
    registry.release(request.engine);
    return {
      status: 500,
      json: { error: "target_failed", message: String(error?.message ?? error) },
    };
  }
  if (!target) {
    registry.release(request.engine);
    return {
      status: 404,
      json: { error: "pr_unknown", message: `PR #${request.pr} is not known to this host repo` },
    };
  }

  // The duration starts here: a run is "how long the review took", so the
  // clock includes the spawn, not just the streaming of its output.
  const startedAt = Date.now();
  let run;
  try {
    run = startRun({ ...request, ...target });
  } catch (error) {
    // The claim must not outlive a start that never produced a run: nothing
    // else would release it, and the engine would read busy forever.
    registry.release(request.engine);
    return {
      status: 500,
      json: { error: "run_start_failed", message: String(error?.message ?? error) },
    };
  }
  registry.bind(request.engine, run);

  return {
    status: 200,
    contentType: "text/event-stream",
    stream: (async function* () {
      // The stream is the record: what it carries is exactly what the
      // history entry keeps (ticket #27), so a run can be re-opened after
      // the fact without re-running it.
      let output = "";
      let truncated = false;
      let timeoutMessage = null;
      let exit = null;
      try {
        for await (const event of run.events) {
          if (event.type === "output") output += event.text;
          else if (event.type === "truncated") truncated = true;
          else if (event.type === "error" && event.reason === "timeout")
            timeoutMessage = event.message;
          else if (event.type === "exit") exit = event;
          yield event;
        }
      } finally {
        registry.release(request.engine);
        history.record({
          engine: request.engine,
          pr: request.pr ?? null,
          ...(request.issue !== undefined ? { issue: request.issue } : {}),
          outcome: reviewRunOutcome(exit, timeoutMessage !== null),
          durationMs: Date.now() - startedAt,
          output,
          truncated,
          message: timeoutMessage,
        });
      }
    })(),
    // The page going away is a cancellation: nothing consumes the stream,
    // so the CLI must not keep running with the engine slot held.
    cancel: () => run.cancel(),
  };
};

export const handleReviewRunCancel = ({ body, host, origin, registry }) => {
  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  let request;
  try {
    request = parseReviewCancelRequest(body);
  } catch {
    return { status: 400, json: { error: "invalid_request", message: "engine is required" } };
  }

  // A claimed-but-unbound engine (still resolving its target) answers
  // cancelled too: the registry remembers the request and applies it the
  // moment the run binds.
  if (!registry.cancel(request.engine)) {
    return {
      status: 404,
      json: { error: "no_run", message: `no active ${request.engine} review` },
    };
  }
  // Cancelling does not free the engine's slot: the CLI is still dying
  // inside its grace window, and a replacement run must stay rejected until
  // the stream's own release runs (ticket #26: one active run per engine).
  return { status: 200, json: { cancelled: true, engine: request.engine } };
};

export const reviewApiPlugin = ({
  probeHealth = () => reviewHealth(),
  startRun = startReviewRun,
  registry = createRunRegistry(),
  history = createRunHistory(),
  resolveTarget,
} = {}) => ({
  name: "workbench-review-api",
  configureServer(server) {
    // The spawned CLIs are detached process groups; a dev-server shutdown is
    // the last chance to stop them. The HTTP server's own close event is the
    // version-proof seam — this Vite core runs no plugin closeServer hook
    // (probed against vite-plus-core 0.2.8).
    server.httpServer?.once("close", () => registry.cancelAll());
    // The runs execute in the host repo — Vite's own notion of the root,
    // overridable by the source-root env (the same resolution ai-api uses).
    const hostRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
    // The target resolver dispatches on the request's shape: a PR resolves
    // through gh, an issue through the local git default branch (issue #40).
    const defaultResolveTarget = (request) =>
      request.pr !== undefined
        ? ghReviewTarget({ hostRoot })(request)
        : ghIssueTarget({ hostRoot })(request);
    server.middlewares.use(
      guardedApi(async (request, response, next, url) => {
        // Route matching comes first: a request this middleware doesn't own
        // must pass through unread — draining its body would break whatever
        // sibling middleware owns it — and only the POST routes read JSON.
        if (!isReviewApiRoute(url.pathname)) return next();
        // The run and cancel routes answer POST only; the history route
        // answers GET only — anything else is a named 405 like the health
        // route gives.
        if (
          request.method !== "POST" &&
          (RUN_ROUTE.test(url.pathname) || CANCEL_ROUTE.test(url.pathname))
        ) {
          return sendJson(response, 405, methodMismatch("POST").json);
        }
        if (request.method !== "GET" && HISTORY_ROUTE.test(url.pathname)) {
          return sendJson(response, 405, methodMismatch("GET").json);
        }
        let body;
        if (RUN_ROUTE.test(url.pathname) || CANCEL_ROUTE.test(url.pathname)) {
          const raw = await readBody(request);
          try {
            body = JSON.parse(raw || "{}");
          } catch {
            return sendJson(response, 400, {
              error: "invalid_request",
              message: "malformed JSON body",
            });
          }
        }
        const handled = HEALTH_ROUTE.test(url.pathname)
          ? await handleReviewApi({
              method: request.method,
              pathname: url.pathname,
              host: request.headers.host,
              origin: request.headers.origin,
              probeHealth,
            })
          : RUN_ROUTE.test(url.pathname)
            ? await handleReviewRunStart({
                body,
                host: request.headers.host,
                origin: request.headers.origin,
                startRun,
                registry,
                history,
                resolveTarget: resolveTarget ?? defaultResolveTarget,
              })
            : CANCEL_ROUTE.test(url.pathname)
              ? handleReviewRunCancel({
                  body,
                  host: request.headers.host,
                  origin: request.headers.origin,
                  registry,
                })
              : handleReviewHistory({
                  method: request.method,
                  pathname: url.pathname,
                  host: request.headers.host,
                  origin: request.headers.origin,
                  history,
                });
        if (!handled) return next();
        if (handled.stream) {
          // The run travels as server-sent events: one JSON event per frame,
          // the stream closing with the run's exit. A client that hangs up —
          // navigation, an aborted fetch — cancels the run, and the handler
          // keeps draining until the process actually exits: releasing the
          // engine slot at hang-up time would let a second run start while
          // the first CLI is still dying in its grace window.
          response.statusCode = handled.status;
          response.setHeader("content-type", handled.contentType);
          // The response's own close is the hang-up signal: the request's
          // fires when its body finishes reading, which a normal POST does
          // immediately — cancelling a review that just started.
          let clientGone = false;
          response.on("close", () => {
            clientGone = true;
            handled.cancel?.();
          });
          for await (const event of handled.stream) {
            if (clientGone) continue;
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          if (!clientGone) response.end();
          return;
        }
        sendJson(response, handled.status, handled.json);
      }),
    );
  },
});
