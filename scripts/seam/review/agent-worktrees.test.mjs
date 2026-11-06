import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  defaultWorktreeRoot,
  discardRetainedRun,
  listRetainedRuns,
  newRunId,
  runIdPattern,
} from "./agent-worktrees.mjs";
import { opencodeEngine } from "./opencode-engine.mjs";
import { envWithoutGitContext } from "../../host/git-context.mjs";

// Real temporary-Git tests for issue-agent worktree ownership (GH-116, ADR
// 0027). Every test builds disposable host repos and one injected worktree
// root, runs the plan's setup steps (everything before the agent step) with
// real git, and calls the plan's own cleanup. No agent, push or gh ever
// runs: the setup and cleanup halves are where runs used to collide.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "workbench-gh116-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const freshDir = (label) => {
  counter += 1;
  return join(scratch, `${label}-${counter}`);
};

const git = (cwd, ...args) => {
  // Under the pre-commit hook GIT_DIR and GIT_INDEX_FILE point at the
  // repository being committed: every fixture git call strips them.
  const result = spawnSync("git", args, { cwd, env: envWithoutGitContext(), encoding: "utf8" });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
};

const mustGit = (cwd, ...args) => {
  const result = git(cwd, ...args);
  strictEqual(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

const makeHostRepo = (label = "host") => {
  const root = freshDir(label);
  mustGit(scratch, "init", "-q", "-b", "main", root);
  mustGit(root, "config", "user.email", "test@example.invalid");
  mustGit(root, "config", "user.name", "Workbench Test");
  mustGit(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "base\n");
  mustGit(root, "add", "README.md");
  mustGit(root, "commit", "-q", "-m", "base");
  return root;
};

// A PID that existed and has exited: the stand-in for a crashed server.
const deadPid = () => {
  const result = spawnSync(process.execPath, ["-e", ""]);
  return result.pid;
};

let runSerial = 0;
const runIdFor = () => {
  runSerial += 1;
  return `20261106-120000-${runSerial.toString(16).padStart(6, "0")}`;
};

const planFor = ({ host, root, issue = 7, runId = runIdFor(), pid, hostname } = {}) => {
  const plan = opencodeEngine.plan(
    { issue, model: "ollama/qwen3-coder:30b", hostRepoRoot: host, baseBranch: "main" },
    {
      env: {},
      which: () => "opencode",
      worktreeRoot: root,
      runId,
      pid: pid ?? process.pid,
      hostname: hostname ?? osHostname(),
    },
  );
  ok(plan, "the plan resolves");
  return { plan, runId };
};

// Runs every step before the agent: the run's setup, exactly as the runner
// would (a best-effort step's failure does not stop the next one).
const setUp = (plan) => {
  for (const step of plan.steps) {
    if (step.name === "agent") break;
    const result = spawnSync(step.command, step.args, {
      cwd: step.cwd,
      env: envWithoutGitContext(),
      encoding: "utf8",
    });
    if (!step.bestEffort)
      strictEqual(result.status, 0, `setup step ${step.name} failed: ${result.stderr}`);
  }
  return plan;
};

const worktreeOf = (plan) => plan.steps.find((step) => step.name === "agent").cwd;
const branchOf = (plan) => plan.steps.find((step) => step.name === "push").args.at(-1);

const listed = (host) =>
  mustGit(host, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const branchHead = (host, branch) => git(host, "rev-parse", "--verify", `refs/heads/${branch}`);

const ownership = (host, root, extra = {}) => ({
  hostRepoRoot: host,
  worktreeRoot: root,
  hostname: osHostname(),
  ...extra,
});

test("two host repos run the same issue number side by side under one root", () => {
  const root = freshDir("root");
  const hostA = makeHostRepo("host-a");
  const hostB = makeHostRepo("host-b");

  const a = setUp(planFor({ host: hostA, root }).plan);
  const b = setUp(planFor({ host: hostB, root }).plan);

  notStrictEqual(worktreeOf(a), worktreeOf(b), "the hosts get distinct paths");
  notStrictEqual(dirname(worktreeOf(a)), dirname(worktreeOf(b)), "each host has its own key");
  ok(worktreeOf(a).startsWith(`${root}/`) && worktreeOf(b).startsWith(`${root}/`));
  ok(existsSync(join(worktreeOf(a), "README.md")));
  ok(existsSync(join(worktreeOf(b), "README.md")));
  ok(listed(hostA).includes(worktreeOf(a)));
  ok(listed(hostB).includes(worktreeOf(b)));
  strictEqual(mustGit(worktreeOf(a), "branch", "--show-current"), branchOf(a));
  strictEqual(mustGit(worktreeOf(b), "branch", "--show-current"), branchOf(b));
});

test("a second server cannot remove or reset an active run's worktree or branch", () => {
  const root = freshDir("root");
  const host = makeHostRepo();

  const first = planFor({ host, root });
  setUp(first.plan);
  // The active run's work in progress: one uncommitted file and one commit.
  writeFileSync(join(worktreeOf(first.plan), "work-in-progress.txt"), "uncommitted\n");
  writeFileSync(join(worktreeOf(first.plan), "README.md"), "agent edit\n");
  mustGit(worktreeOf(first.plan), "commit", "-q", "-am", "agent commit");
  const headBefore = branchHead(host, branchOf(first.plan)).stdout;

  // A second process (its own in-memory registry) starts the same issue.
  const second = planFor({ host, root });
  setUp(second.plan);

  notStrictEqual(worktreeOf(second.plan), worktreeOf(first.plan));
  notStrictEqual(branchOf(second.plan), branchOf(first.plan));
  strictEqual(
    readFileSync(join(worktreeOf(first.plan), "work-in-progress.txt"), "utf8"),
    "uncommitted\n",
    "run 1's uncommitted file survives",
  );
  strictEqual(branchHead(host, branchOf(first.plan)).stdout, headBefore, "run 1's head is intact");
  strictEqual(readFileSync(join(worktreeOf(second.plan), "README.md"), "utf8"), "base\n");

  // Run 1 is locked by this live process on this host: discard is refused.
  const runs = listRetainedRuns(ownership(host, root));
  strictEqual(runs.find((run) => run.runId === first.runId)?.state, "active");
  const refused = discardRetainedRun({ ...ownership(host, root), runId: first.runId });
  strictEqual(refused.status, "active");
  const refusedConfirmed = discardRetainedRun({
    ...ownership(host, root),
    runId: first.runId,
    confirmQuarantined: true,
  });
  strictEqual(refusedConfirmed.status, "active", "confirmation never overrides a live lock");
  ok(existsSync(join(worktreeOf(first.plan), "work-in-progress.txt")));
  strictEqual(branchHead(host, branchOf(first.plan)).stdout, headBefore);
});

test("a successful run's cleanup removes only its own worktree and branch", () => {
  const root = freshDir("root");
  const host = makeHostRepo();
  const one = setUp(planFor({ host, root }).plan);
  const two = setUp(planFor({ host, root }).plan);

  one.cleanup({ ok: true });

  strictEqual(existsSync(worktreeOf(one)), false, "run 1's worktree is gone");
  strictEqual(branchHead(host, branchOf(one)).status === 0, false, "run 1's branch is gone");
  strictEqual(listed(host).includes(worktreeOf(one)), false);
  ok(existsSync(join(worktreeOf(two), "README.md")), "run 2's worktree is untouched");
  strictEqual(branchHead(host, branchOf(two)).status, 0, "run 2's branch is untouched");
  ok(listed(host).includes(worktreeOf(two)));
});

test("a retry starts from a fresh checkout and keeps the retained run's evidence", () => {
  const root = freshDir("root");
  const host = makeHostRepo();
  const failed = planFor({ host, root });
  setUp(failed.plan);
  writeFileSync(join(worktreeOf(failed.plan), "README.md"), "inspection edit\n");
  failed.plan.cleanup({ ok: false });

  const runs = listRetainedRuns(ownership(host, root));
  strictEqual(
    runs.find((run) => run.runId === failed.runId)?.state,
    "retained",
    "an ended run is unlocked and retained",
  );

  const retry = planFor({ host, root });
  setUp(retry.plan);

  strictEqual(
    readFileSync(join(worktreeOf(failed.plan), "README.md"), "utf8"),
    "inspection edit\n",
    "the retained run's edit survives the retry",
  );
  strictEqual(readFileSync(join(worktreeOf(retry.plan), "README.md"), "utf8"), "base\n");
  strictEqual(mustGit(worktreeOf(retry.plan), "status", "--porcelain"), "", "a fresh checkout");
  strictEqual(
    mustGit(worktreeOf(retry.plan), "rev-parse", "HEAD"),
    mustGit(host, "rev-parse", "main"),
    "the retry's branch starts at the base",
  );
});

test("the retained-run list names only this host's run-owned worktrees", () => {
  const root = freshDir("root");
  const host = makeHostRepo();
  const other = makeHostRepo("other");
  const mine = planFor({ host, root, issue: 12 });
  setUp(mine.plan);
  mine.plan.cleanup({ ok: false });
  setUp(planFor({ host: other, root, issue: 12 }).plan);
  // An old-scheme leftover and a hand-made worktree are never listed.
  mustGit(host, "worktree", "add", "-q", join(root, "workbench-issue-12"), "-b", "agent/issue-12");
  mustGit(host, "worktree", "add", "-q", freshDir("manual"), "-b", "manual-branch");

  deepStrictEqual(listRetainedRuns(ownership(host, root)), [
    {
      issue: 12,
      runId: mine.runId,
      branch: `agent/issue-12-${mine.runId}`,
      path: worktreeOf(mine.plan),
      state: "retained",
    },
  ]);
});

test("discard removes exactly one retained run and never deletes the remote branch", () => {
  const root = freshDir("root");
  const host = makeHostRepo();
  const remote = freshDir("remote.git");
  mustGit(scratch, "init", "-q", "--bare", remote);
  mustGit(host, "remote", "add", "origin", remote);

  const target = planFor({ host, root });
  setUp(target.plan);
  mustGit(worktreeOf(target.plan), "push", "-q", "-u", "origin", branchOf(target.plan));
  target.plan.cleanup({ ok: false });
  const keeper = planFor({ host, root });
  setUp(keeper.plan);
  keeper.plan.cleanup({ ok: false });

  const result = discardRetainedRun({ ...ownership(host, root), runId: target.runId });
  strictEqual(result.status, "discarded");

  strictEqual(existsSync(worktreeOf(target.plan)), false);
  strictEqual(branchHead(host, branchOf(target.plan)).status === 0, false);
  strictEqual(
    git(remote, "rev-parse", "--verify", `refs/heads/${branchOf(target.plan)}`).status,
    0,
    "the remote branch is never deleted",
  );
  ok(existsSync(worktreeOf(keeper.plan)), "the other retained run is untouched");
  strictEqual(branchHead(host, branchOf(keeper.plan)).status, 0);

  strictEqual(
    discardRetainedRun({ ...ownership(host, root), runId: target.runId }).status,
    "not_found",
    "a second discard finds nothing",
  );
  strictEqual(
    discardRetainedRun({ ...ownership(host, root), runId: "20261106-120000-ffffff" }).status,
    "not_found",
  );
});

test("discard refuses a run whose branch no longer matches the expected one", () => {
  const root = freshDir("root");
  const host = makeHostRepo();
  const run = planFor({ host, root });
  setUp(run.plan);
  run.plan.cleanup({ ok: false });
  mustGit(worktreeOf(run.plan), "switch", "-q", "-c", "someone-elses-branch");

  strictEqual(
    discardRetainedRun({ ...ownership(host, root), runId: run.runId }).status,
    "not_found",
  );
  ok(existsSync(worktreeOf(run.plan)), "a mismatched worktree is left alone");
});

test("a lock whose PID is dead, or from another host, is quarantined and needs confirmation", () => {
  const root = freshDir("root");
  const host = makeHostRepo();
  const crashed = planFor({ host, root, pid: deadPid() });
  setUp(crashed.plan);
  const foreign = planFor({ host, root, hostname: "some-other-host" });
  setUp(foreign.plan);

  const states = Object.fromEntries(
    listRetainedRuns(ownership(host, root)).map((run) => [run.runId, run.state]),
  );
  strictEqual(states[crashed.runId], "quarantined");
  strictEqual(states[foreign.runId], "quarantined", "a live PID on another host proves nothing");

  for (const { runId, plan } of [crashed, foreign]) {
    strictEqual(
      discardRetainedRun({ ...ownership(host, root), runId }).status,
      "confirmation_required",
    );
    ok(existsSync(worktreeOf(plan)), "an unconfirmed discard does nothing");
    strictEqual(
      discardRetainedRun({ ...ownership(host, root), runId, confirmQuarantined: true }).status,
      "discarded",
    );
    strictEqual(existsSync(worktreeOf(plan)), false);
    strictEqual(branchHead(host, branchOf(plan)).status === 0, false);
  }
});

test("the durable root is the override, else the XDG state dir, else ~/.local/state — never tmp", () => {
  const home = () => "/home/dev";
  strictEqual(
    defaultWorktreeRoot({ WORKBENCH_WORKTREE_ROOT: "/srv/wt", XDG_STATE_HOME: "/x" }, home),
    "/srv/wt",
  );
  strictEqual(defaultWorktreeRoot({ XDG_STATE_HOME: "/x" }, home), "/x/workbench/worktrees");
  strictEqual(
    defaultWorktreeRoot({ XDG_STATE_HOME: "relative" }, home),
    "/home/dev/.local/state/workbench/worktrees",
    "a relative XDG_STATE_HOME is ignored, as the spec requires",
  );
  strictEqual(defaultWorktreeRoot({}, home), "/home/dev/.local/state/workbench/worktrees");
  strictEqual(defaultWorktreeRoot({}).startsWith(tmpdir()), false);
});

test("a run id is a UTC timestamp plus a random suffix, safe in paths and refs", () => {
  const id = newRunId({ now: new Date("2026-11-06T09:08:07.123Z"), random: () => "0a1b2c" });
  strictEqual(id, "20261106-090807-0a1b2c");
  ok(runIdPattern.test(newRunId()));
  notStrictEqual(newRunId(), newRunId());
  strictEqual(git(scratch, "check-ref-format", `refs/heads/agent/issue-7-${id}`).status, 0);
});
