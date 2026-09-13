import { deepStrictEqual, match, strictEqual } from "node:assert";
import test from "node:test";

import { postReviewComment } from "./review-comment.mjs";

// The comment-posting operation of the review runner seam (epic #20, ticket
// #25). The spawn function is the seam's I/O boundary: a fake answers for
// `gh` so the tests stay hermetic and never touch the network or a real
// comment. The fake records every request it receives, so the tests can
// also prove posting is exactly the one comment command — never a review,
// never anything else — and that it cannot hang the endpoint.

const cli = (answer) => {
  const calls = [];
  const spawn = async (request) => {
    calls.push(request);
    return answer(request.args) ?? { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
};

const enoent = (command) => ({
  status: null,
  stdout: "",
  stderr: "",
  error: Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }),
});

test("a confirmed post shells the local gh with exactly one command", async () => {
  const { spawn, calls } = cli((args) =>
    args[0] === "pr"
      ? {
          status: 0,
          stdout: "https://github.com/Quick-Release/workbench/pull/25#issuecomment-1\n",
          stderr: "",
        }
      : { status: 0, stdout: "", stderr: "" },
  );
  const outcome = await postReviewComment({
    spawn,
    engine: "coderabbit",
    pr: 25,
    findings: "## Findings\n\n- the login form leaks the token in the redirect url",
    cwd: "/host/repo",
  });
  deepStrictEqual(outcome, {
    ok: true,
    result: {
      engine: "coderabbit",
      pr: 25,
      message: "Review findings posted to PR #25.",
      commentUrl: "https://github.com/Quick-Release/workbench/pull/25#issuecomment-1",
    },
  });
  // The exact probed argv — posting is the one comment command, nothing
  // else, ever — run against the host repo, bounded so a hung gh cannot
  // hold the endpoint.
  strictEqual(calls.length, 1);
  const { command, args, cwd, timeout } = calls[0];
  strictEqual(command, "gh");
  deepStrictEqual(args.slice(0, 4), ["pr", "comment", "25", "--body"]);
  match(args[4], /login form leaks the token in the redirect url/);
  match(args[4], /coderabbit/);
  match(args[4], /PR #25/);
  strictEqual(cwd, "/host/repo");
  strictEqual(typeof timeout === "number" && timeout > 0, true);
});

test("a missing gh binary is a named state with the install command, not a crash", async () => {
  const { spawn } = cli(() => enoent("gh"));
  const outcome = await postReviewComment({
    spawn,
    engine: "zcode",
    pr: 25,
    findings: "findings",
    cwd: "/host/repo",
  });
  deepStrictEqual(outcome, {
    ok: false,
    status: 422,
    error: "gh_missing",
    remediation: "install the GitHub CLI: brew install gh",
  });
});

test("gh's own not-logged-in complaint surfaces as gh_auth_missing with the login command", async () => {
  const { spawn } = cli(() => ({
    status: 4,
    stdout: "",
    stderr: "gh: To get started with GitHub CLI, please run: gh auth login",
  }));
  const outcome = await postReviewComment({
    spawn,
    engine: "coderabbit",
    pr: 25,
    findings: "findings",
    cwd: "/host/repo",
  });
  deepStrictEqual(outcome, {
    ok: false,
    status: 422,
    error: "gh_auth_missing",
    remediation: "run `gh auth login` to authenticate the GitHub CLI",
  });
});

test("a rejected token (env-var or keyring) reads as gh_auth_missing too", async () => {
  const { spawn } = cli(() => ({
    status: 1,
    stdout: "",
    stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)",
  }));
  const outcome = await postReviewComment({
    spawn,
    engine: "zcode",
    pr: 25,
    findings: "findings",
    cwd: "/host/repo",
  });
  strictEqual(outcome.error, "gh_auth_missing");
  strictEqual(outcome.remediation, "run `gh auth login` to authenticate the GitHub CLI");
});

test("a bare 'auth required' complaint reads as gh_auth_missing as well", async () => {
  const { spawn } = cli(() => ({
    status: 1,
    stdout: "",
    stderr: "auth required",
  }));
  const outcome = await postReviewComment({
    spawn,
    engine: "zcode",
    pr: 25,
    findings: "findings",
    cwd: "/host/repo",
  });
  strictEqual(outcome.error, "gh_auth_missing");
  strictEqual(outcome.remediation, "run `gh auth login` to authenticate the GitHub CLI");
});

test("a gh that outlives its timeout is a typed post_timed_out, not a generic failure", async () => {
  // The fake answers in the spawn contract's own shape: a timed-out
  // execFile is status null with the kill flagged.
  const { spawn } = cli(() => ({
    status: null,
    stdout: "",
    stderr: "",
    timedOut: true,
    error: Object.assign(new Error("Command was killed with SIGTERM"), { killed: true }),
  }));
  const outcome = await postReviewComment({
    spawn,
    engine: "coderabbit",
    pr: 25,
    findings: "findings",
    cwd: "/host/repo",
  });
  deepStrictEqual(outcome, {
    ok: false,
    status: 504,
    error: "post_timed_out",
    message: "gh pr comment did not answer within 30 seconds",
  });
});

test("a failed comment write that is not about auth surfaces gh's own complaint", async () => {
  const { spawn } = cli(() => ({
    status: 1,
    stdout: "",
    stderr: "GraphQL: Project item already exists (unnamed)",
  }));
  const outcome = await postReviewComment({
    spawn,
    engine: "zcode",
    pr: 26,
    findings: "findings",
    cwd: "/host/repo",
  });
  deepStrictEqual(outcome, {
    ok: false,
    status: 502,
    error: "post_failed",
    message: "GraphQL: Project item already exists (unnamed)",
  });
});

test("a gh success answer without a comment url is post_failed, not a linkless 'posted'", async () => {
  const { spawn } = cli(() => ({ status: 0, stdout: "", stderr: "" }));
  const outcome = await postReviewComment({
    spawn,
    engine: "coderabbit",
    pr: 25,
    findings: "findings",
    cwd: "/host/repo",
  });
  strictEqual(outcome.ok, false);
  strictEqual(outcome.status, 502);
  strictEqual(outcome.error, "post_failed");
  match(outcome.message, /url/);
});
