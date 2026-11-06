import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir as osHomedir, hostname as osHostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { agentRunIdPattern } from "../../../src/schema.ts";
import { envWithoutGitContext } from "../../host/git-context.mjs";

// Issue-agent run ownership (GH-116, ADR 0027). Every Agent run owns one
// worktree and one branch, both named for its run id, under a durable root
// for each user and a key for the host repo. Git's own worktree lock records
// who owns an active run; nothing here infers ownership from a name alone.
// A run's cleanup, the retained-run list and Discard all act only on paths
// and branches this module can rebuild from root, host key and run id, and
// only once `git worktree list` confirms that exact path on that exact
// branch for this host repo.

// A run id: UTC timestamp plus a random suffix. Digits, hex and hyphens
// only, so it is safe in a path, a ref name and a lock reason. The seam's
// Schema owns the pattern, so the Discard request and the run agree.
export const runIdPattern = agentRunIdPattern;

export const newRunId = ({
  now = new Date(),
  random = () => randomBytes(3).toString("hex"),
} = {}) => {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${random()}`;
};

// The durable root: an explicit override, else the XDG state directory, else
// its documented default. The temporary directory is not a candidate — it
// is wiped at reboot, which would silently break retention.
export const defaultWorktreeRoot = (env = process.env, homedir = osHomedir) => {
  if (env.WORKBENCH_WORKTREE_ROOT) return resolve(env.WORKBENCH_WORKTREE_ROOT);
  const stateHome = env.XDG_STATE_HOME?.startsWith("/")
    ? env.XDG_STATE_HOME
    : join(homedir(), ".local", "state");
  return join(stateHome, "workbench", "worktrees");
};

const defaultGit = (args, cwd) => {
  // A caller's git context (a hook's GIT_DIR) must never redirect these
  // commands away from the host repo they name.
  const result = spawnSync("git", args, {
    cwd,
    env: envWithoutGitContext(),
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const realpathOr = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// The host key: a short digest of the real Git common directory, so every
// worktree of one repository (and any path spelling of it) shares one key,
// and two repositories never do.
export const hostKeyFor = (hostRepoRoot, runGit = defaultGit) => {
  const result = runGit(["rev-parse", "--git-common-dir"], hostRepoRoot);
  const commonDir =
    result.status === 0 && result.stdout.trim()
      ? resolve(hostRepoRoot, result.stdout.trim())
      : resolve(hostRepoRoot);
  return createHash("sha256").update(realpathOr(commonDir)).digest("hex").slice(0, 12);
};

export const runResources = ({ root, hostKey, issue, runId }) => ({
  path: join(root, hostKey, `issue-${issue}-${runId}`),
  branch: `agent/issue-${issue}-${runId}`,
});

export const lockReason = ({ runId, pid, hostname }) =>
  `workbench run ${runId} pid ${pid} host ${hostname}`;

const parseLockReason = (reason) => {
  const match = /^workbench run (\S+) pid (\d+) host (.+)$/.exec(reason ?? "");
  return match ? { runId: match[1], pid: Number(match[2]), hostname: match[3] } : null;
};

export const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
};

// `git worktree list --porcelain -z`: NUL-terminated attribute fields, one
// empty field between records, so no path spelling can break the parse.
const parseWorktreeList = (output) => {
  const records = [];
  let current = null;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? null : field.slice(space + 1);
    if (key === "worktree") current = { path: value, branch: null, locked: false, lock: null };
    else if (!current) continue;
    else if (key === "branch") current.branch = value;
    else if (key === "locked") {
      current.locked = true;
      current.lock = value;
    }
  }
  if (current) records.push(current);
  return records;
};

const runDirPattern = new RegExp(`^issue-(\\d+)-(${runIdPattern.source.slice(1, -1)})$`);

// The lock is evidence, never proof: a live PID on this host refuses a
// discard; a dead PID, a lock from another host, or a lock Workbench did not
// write leaves the worktree quarantined until the Developer confirms.
const classify = ({ locked, lock }, { hostname, isPidAlive: alive }) => {
  if (!locked) return "retained";
  const owner = parseLockReason(lock);
  if (owner && owner.pid > 0 && owner.hostname === hostname && alive(owner.pid)) return "active";
  return "quarantined";
};

// This host repo's run-owned worktrees: entries directly under
// <root>/<host-key>/ named issue-<n>-<run-id> and checked out on exactly
// agent/issue-<n>-<run-id>. Old-scheme leftovers and hand-made worktrees
// never match, so they are never listed or touched.
export const listRetainedRuns = ({
  hostRepoRoot,
  worktreeRoot,
  env = process.env,
  homedir = osHomedir,
  hostname = osHostname(),
  isPidAlive: alive = isPidAlive,
  runGit = defaultGit,
}) => {
  const root = worktreeRoot ?? defaultWorktreeRoot(env, homedir);
  const prefix = join(root, hostKeyFor(hostRepoRoot, runGit));
  const prefixes = new Set([prefix, realpathOr(prefix)]);
  const result = runGit(["worktree", "list", "--porcelain", "-z"], hostRepoRoot);
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `git worktree list failed in ${hostRepoRoot}`);
  const runs = [];
  for (const entry of parseWorktreeList(result.stdout)) {
    if (!entry.path || !prefixes.has(dirname(entry.path))) continue;
    const match = runDirPattern.exec(basename(entry.path));
    if (!match) continue;
    const issue = Number(match[1]);
    const runId = match[2];
    const { branch } = runResources({ root, hostKey: "", issue, runId });
    if (entry.branch !== `refs/heads/${branch}`) continue;
    runs.push({
      issue,
      runId,
      branch,
      path: entry.path,
      state: classify(entry, { hostname, isPidAlive: alive }),
    });
  }
  return runs;
};

// Discard: the request names a run id, never a path. The server finds the
// one listed worktree the root, host key and run id rebuild, on its exact
// branch, and removes that worktree and its local branch. Remote branches
// (an open draft PR's head) are never deleted.
export const discardRetainedRun = ({ runId, confirmQuarantined = false, ...ownership }) => {
  const runGit = ownership.runGit ?? defaultGit;
  if (typeof runId !== "string" || !runIdPattern.test(runId)) return { status: "not_found" };
  const run = listRetainedRuns(ownership).find((candidate) => candidate.runId === runId);
  if (!run) return { status: "not_found" };
  if (run.state === "active") return { status: "active", run };
  if (run.state === "quarantined" && confirmQuarantined !== true)
    return { status: "confirmation_required", run };

  const { hostRepoRoot } = ownership;
  if (run.state === "quarantined") {
    const unlocked = runGit(["worktree", "unlock", run.path], hostRepoRoot);
    if (unlocked.status !== 0) return { status: "failed", run, message: unlocked.stderr.trim() };
  }
  const removed = runGit(["worktree", "remove", "--force", run.path], hostRepoRoot);
  if (removed.status !== 0) return { status: "failed", run, message: removed.stderr.trim() };
  const deleted = runGit(["branch", "-D", run.branch], hostRepoRoot);
  if (deleted.status !== 0) return { status: "failed", run, message: deleted.stderr.trim() };
  return { status: "discarded", run };
};
