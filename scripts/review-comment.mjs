import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The comment-posting operation of the review runner seam (epic #20, ticket
// #25): a completed review's findings go to the reviewed PR as one GitHub
// comment. The consent lives entirely in the UI's explicit per-run
// confirmation — this module is the write itself, never the decision. It
// shells the Developer's local `gh`, whose own token resolution (env var
// first, `gh auth token` fallback) is the same approach the sync uses — so
// the write, not a pre-flight probe, is the ground truth for authentication:
// a Developer posting purely on an environment token is never told to run
// `gh auth login` when the post would succeed. Runs against the host repo so
// `gh` comments on the right repository. The spawn function is injected so
// tests substitute a fake CLI; the endpoint and the UI are thin layers over
// this module.

// The spawn contract: `spawn({ command, args, cwd, timeout })` runs the CLI
// and returns `{ status, stdout, stderr, error? }` — never throws. The
// timeout bounds how long a hung `gh` can hold the endpoint; a comment post
// is one network round-trip.
const nodeSpawn = async ({ command, args, cwd, timeout }) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      timeout,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return {
      status: typeof error?.code === "number" ? error.code : null,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? ""),
      error,
    };
  }
};

const commentBody = ({ findings, engine, pr }) =>
  `${findings.trim()}\n\n---\n\nPosted from the workbench dashboard — ${engine} review of PR #${pr}.`;

// A hung or slow `gh` must not hold the endpoint forever; one network
// round-trip plus CLI startup is seconds, not minutes.
const POST_TIMEOUT_MS = 30_000;

// Not having `gh` at all is fixable in one step, so it is a named state
// with the install command rather than a crash or a silent no-op. The same
// goes for a missing or rejected login: gh's own complaint on a failed post
// carries it.
const GH_INSTALL = "install the GitHub CLI: brew install gh";
const GH_LOGIN = "run `gh auth login` to authenticate the GitHub CLI";

const ghMissing = () => ({
  ok: false,
  status: 422,
  error: "gh_missing",
  remediation: GH_INSTALL,
});

const ghAuthMissing = () => ({
  ok: false,
  status: 422,
  error: "gh_auth_missing",
  remediation: GH_LOGIN,
});

// gh names authentication failures variously across versions and token
// sources ("run: gh auth login", "unauthorized", "bad credentials", HTTP
// 401); the write's stderr is classified rather than trusted to one string.
const authShaped = (text) =>
  /auth(?:entication)|login|token|credential|unauthorized|401/i.test(text ?? "");

export const postReviewComment = async ({ spawn = nodeSpawn, engine, pr, findings, cwd }) => {
  const posted = await spawn({
    command: "gh",
    args: ["pr", "comment", String(pr), "--body", commentBody({ findings, engine, pr })],
    cwd,
    timeout: POST_TIMEOUT_MS,
  });
  // The exact probed argv is the seam's safety invariant: posting is the
  // one comment command, nothing else, ever.
  if (posted.error?.code === "ENOENT") return ghMissing();
  if (posted.status !== 0) {
    const complaint =
      (posted.stderr ?? "").trim() ||
      posted.error?.message ||
      `gh pr comment exited with status ${posted.status}`;
    if (authShaped(complaint)) return ghAuthMissing();
    return {
      ok: false,
      status: 502,
      error: "post_failed",
      message: complaint,
    };
  }
  const commentUrl = (posted.stdout ?? "").trim();
  if (!commentUrl)
    return {
      ok: false,
      status: 502,
      error: "post_failed",
      message: "gh pr comment succeeded but did not answer with the comment's url",
    };
  return {
    ok: true,
    result: {
      engine,
      pr,
      message: `Review findings posted to PR #${pr}.`,
      commentUrl,
    },
  };
};
