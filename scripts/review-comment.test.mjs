import { deepStrictEqual, match, strictEqual } from "node:assert";
import test from "node:test";

import { postReviewComment } from "./review-comment.mjs";

// The comment-posting operation of the review runner seam (epic #20, ticket
// #25). The spawn function is the seam's I/O boundary: a fake answers for
// `gh` so the tests stay hermetic and never touch the network or a real
// comment. The fake records every argv it is asked to run, so the tests can
// also prove posting is only ever the auth probe and the one comment
// command — never a review, never anything else.

const cli = (answer) => {
  const calls = [];
  const spawn = async ({ command, args }) => {
    calls.push([command, ...args]);
    return answer(args) ?? { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
};

const enoent = (command) => ({
  status: null,
  stdout: "",
  stderr: "",
  error: Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }),
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

test("a gh binary that vanishes between the probe and the write still reads gh_missing", async () => {
  const { spawn } = cli((args) =>
    args[0] === "auth" ? { status: 0, stdout: "", stderr: "" } : enoent("gh"),
  );
  const outcome = await postReviewComment({
    spawn,
    engine: "zcode",
    pr: 25,
    findings: "findings",
    cwd: "/host/repo",
  });
  strictEqual(outcome.error, "gh_missing");
  strictEqual(outcome.remediation, "install the GitHub CLI: brew install gh");
});

test("a failed comment write surfaces gh's own complaint as post_failed", async () => {
  const { spawn } = cli((args) =>
    args[0] === "pr"
      ? { status: 1, stdout: "", stderr: "GraphQL: Project item already exists (unnamed)" }
      : { status: 0, stdout: "", stderr: "" },
  );
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

test("an unauthenticated gh is a named state with the login command, before anything is sent", async () => {
  // The probe answers with gh's real unauthenticated shape: non-zero exit,
  // stderr carrying gh's own complaint.
  const { spawn, calls } = cli((args) =>
    args[0] === "auth"
      ? {
          status: 4,
          stdout: "",
          stderr: "gh: To get started with GitHub CLI, please run: gh auth login",
        }
      : { status: 0, stdout: "", stderr: "" },
  );
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
  // The probe failure stops the write: the comment command never runs.
  strictEqual(calls.length, 1);
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

test("a confirmed post shells the local gh: auth probe, then the one comment command", async () => {
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
  // The exact probed argv, in order — posting is the auth probe and the
  // comment write, nothing else.
  strictEqual(calls.length, 2);
  deepStrictEqual(calls[0], ["gh", "auth", "status"]);
  const comment = calls[1];
  deepStrictEqual(comment.slice(0, 5), ["gh", "pr", "comment", "25", "--body"]);
  match(comment[5], /login form leaks the token in the redirect url/);
  match(comment[5], /coderabbit/);
  match(comment[5], /PR #25/);
});
