import { parseReviewCommentRequest, parseReviewCommentResult } from "../src/schema.ts";
import { methodMismatch, readBody } from "./api-shared.mjs";
import { resolve } from "node:path";
import { gateRejection } from "./request-gate.mjs";
import { postReviewComment } from "./review-comment.mjs";

// The review comment API middleware (epic #20, ticket #25): the endpoint
// the dashboard's confirm flow calls to post a completed review's findings
// as one comment on the reviewed PR. The handler is pure — request parts
// in, a response part out — and the runner's poster is injected, so tests
// stub it and no real `gh` is ever touched. The request surface is
// enumerated (engine + pr + findings — the comment body is composed
// server-side, never accepted from the page), the shared gate rejects
// foreign hosts and cross-origin requests, and the runner's typed failures
// pass through with their statuses so the UI can render the one-step fix.

const COMMENT_ROUTE = /^\/api\/review\/comment\/?$/;

export const isReviewCommentApiRoute = (pathname) => COMMENT_ROUTE.test(pathname);

// One GitHub comment is the delivery vehicle, so the findings must fit in
// one: a comment tops out at 65,536 characters, and the cap leaves room for
// the attribution footer.
const MAX_FINDINGS_LENGTH = 60_000;

const rejection = (status, json) => ({ status, json });

// Bounds the schema alone cannot express (workflow's no-fields check is the
// precedent): a PR number that names a pull request, findings worth
// posting, findings that fit one comment.
const boundsRejection = ({ pr, findings }) => {
  if (!Number.isInteger(pr) || pr <= 0)
    return rejection(400, { message: "pr must be a positive integer" });
  if (!findings.trim()) return rejection(400, { message: "an empty review has nothing to post" });
  if (findings.length > MAX_FINDINGS_LENGTH)
    return rejection(400, {
      message: `the findings exceed one comment's worth of text (${MAX_FINDINGS_LENGTH} character maximum)`,
    });
  return null;
};

export const handleReviewCommentApi = async ({
  method,
  pathname,
  host,
  origin,
  body,
  postComment,
  cwd,
}) => {
  if (!isReviewCommentApiRoute(pathname)) return null;

  const gate = gateRejection({ host, origin });
  if (gate) return gate;

  if (method !== "POST") return methodMismatch("POST");

  let raw;
  try {
    raw = JSON.parse(body ?? "");
  } catch {
    return rejection(400, { message: "request body is not valid JSON" });
  }
  let request;
  try {
    request = parseReviewCommentRequest(raw);
  } catch (error) {
    return rejection(400, { message: String(error?.message ?? error) });
  }
  const bounds = boundsRejection(request);
  if (bounds) return bounds;

  const outcome = await postComment({
    engine: request.engine,
    pr: request.pr,
    findings: request.findings,
    cwd,
  });
  if (!outcome.ok) {
    const json = { error: outcome.error };
    if (outcome.message !== undefined) json.message = outcome.message;
    if (outcome.remediation !== undefined) json.remediation = outcome.remediation;
    return rejection(outcome.status, json);
  }
  return { status: 200, json: parseReviewCommentResult(outcome.result) };
};

export const reviewCommentApiPlugin = ({ postComment = postReviewComment } = {}) => ({
  name: "workbench-review-comment-api",
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      // Connect does not consume this async middleware's promise, so an
      // exception here (a malformed request URL failing `new URL`, say)
      // would hang the request as an unhandled rejection — forward it.
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (!isReviewCommentApiRoute(url.pathname)) return next();
        // The host repo the poster's `gh` runs against — the same
        // resolution the workflow seam uses.
        const cwd = resolve(process.env.WORKBENCH_SOURCE_ROOT || server.config.root);
        const body = request.method === "POST" ? await readBody(request) : undefined;
        const handled = await handleReviewCommentApi({
          method: request.method,
          pathname: url.pathname,
          host: request.headers.host,
          origin: request.headers.origin,
          body,
          postComment,
          cwd,
        });
        if (!handled) return next();
        response.statusCode = handled.status;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(handled.json));
      } catch (error) {
        next(error);
      }
    });
  },
});
