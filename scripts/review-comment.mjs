import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The comment-posting operation of the review runner seam (epic #20, ticket
// #25): a completed review's findings go to the reviewed PR as one GitHub
// comment. The consent lives entirely in the UI's explicit per-run
// confirmation — this module is the write itself, never the decision. It
// shells the Developer's local `gh`, whose own token resolution (env var
// first, `gh auth token` fallback) is the same approach the sync uses, and
// runs against the host repo so `gh` reviews the right repository. The
// spawn function is injected so tests substitute a fake CLI; the endpoint
// and the UI are thin layers over this module.

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

// Not having `gh` at all is fixable in one step, so it is a named state
// with the install command rather than a crash or a silent no-op.
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

export const postReviewComment = async ({ spawn = nodeSpawn, engine, pr, findings, cwd }) => {
  // The probe is the consent gate's counterpart on the environment: a
  // missing login is caught here, before anything is sent, as a named
  // state with its one-step fix — never as an opaque failure mid-post.
  const probe = await spawn({ command: "gh", args: ["auth", "status"], cwd });
  if (probe.error?.code === "ENOENT") return ghMissing();
  if (probe.status !== 0) return ghAuthMissing();
  const posted = await spawn({
    command: "gh",
    args: ["pr", "comment", String(pr), "--body", commentBody({ findings, engine, pr })],
    cwd,
  });
  // gh answered the auth probe fine but the write itself failed: surface
  // gh's own complaint — it is what the Developer can act on. The binary
  // can also vanish between the probe and the write; that reads as
  // gh_missing, the same one-step fix. A success answer that names no
  // comment url is gh misbehaving, not a posted comment with an empty link.
  if (posted.error?.code === "ENOENT") return ghMissing();
  if (posted.status !== 0)
    return {
      ok: false,
      status: 502,
      error: "post_failed",
      message:
        (posted.stderr ?? "").trim() ||
        posted.error?.message ||
        `gh pr comment exited with status ${posted.status}`,
    };
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
