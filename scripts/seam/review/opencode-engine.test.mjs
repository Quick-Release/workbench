import { deepStrictEqual, match, strictEqual } from "node:assert";
import test from "node:test";

import { defaultModel, opencodeEngine } from "./opencode-engine.mjs";

// The opencode issue-agent engine (issue #40). Two seams are under test, the
// ones the issue's testing decisions pre-agree: the exact argv sequences of
// the engine's plan (worktree, agent, commit, push, draft PR) and the health
// probe's typed states. The fake spawn records every argv; the fake ollama
// tags loader answers for the local model server; no real CLI or HTTP call
// runs in these tests.

const planRequest = (overrides = {}) => ({
  issue: 40,
  model: "ollama/qwen3-coder:30b",
  hostRepoRoot: "/host/repo",
  baseBranch: "origin/main",
  ...overrides,
});

// A plan builder with every outside influence pinned: the binary resolves,
// the worktree path is fixed, and the cleanup spawn records its argv.
const builtPlan = (requestOverrides = {}, depOverrides = {}) => {
  const cleanupCalls = [];
  const plan = opencodeEngine.plan(planRequest(requestOverrides), {
    env: {},
    which: () => "/usr/local/bin/opencode",
    tmpdir: () => "/tmp",
    worktreePath: "/tmp/workbench-issue-40-fixed",
    cleanupSpawn: ({ command, args, cwd }) => {
      cleanupCalls.push({ command, args, cwd });
      return { status: 0 };
    },
    ...depOverrides,
  });
  return { plan, cleanupCalls };
};

const stepByName = (plan, name) => plan.steps.find((step) => step.name === name);

test("the plan choreographs clearing, worktree, agent, staging, commit, push, and draft PR", () => {
  const { plan } = builtPlan();
  deepStrictEqual(
    plan.steps.map((step) => step.name),
    ["clear", "worktree", "agent", "stage", "commit", "push", "pull-request"],
  );
});

test("the clearing step is best-effort so a first run and a retry both proceed", () => {
  const { plan } = builtPlan();
  const step = stepByName(plan, "clear");
  strictEqual(step.bestEffort, true, "a missing leftover must not fail the run");
  deepStrictEqual(step.args, ["worktree", "remove", "--force", "/tmp/workbench-issue-40-fixed"]);
  deepStrictEqual(step.cwd, "/host/repo");
});

test("the worktree step forks the default branch on an agent/issue-<n> branch", () => {
  const { plan } = builtPlan();
  const step = stepByName(plan, "worktree");
  deepStrictEqual(step.command, "git");
  deepStrictEqual(step.args, [
    "worktree",
    "add",
    "/tmp/workbench-issue-40-fixed",
    "-B",
    "agent/issue-40",
    "origin/main",
  ]);
  strictEqual(step.cwd, "/host/repo", "the worktree is created from the host repo");
});

test("the agent step runs the resolved opencode binary on the worktree with json events", () => {
  const { plan } = builtPlan();
  const step = stepByName(plan, "agent");
  strictEqual(step.command, "/usr/local/bin/opencode");
  strictEqual(step.cwd, "/tmp/workbench-issue-40-fixed");
  strictEqual(step.args[0], "run");
  strictEqual(step.args[2], "--model");
  strictEqual(step.args[3], "ollama/qwen3-coder:30b");
  strictEqual(step.args[4], "--format");
  strictEqual(step.args[5], "json");
  strictEqual(step.args[6], "--auto", "unattended runs auto-approve what the fence allows");
  deepStrictEqual(step.args.slice(2).filter((arg) => arg === "--model").length, 1);
});

test("the agent step carries the permission fence as inline config", () => {
  const { plan } = builtPlan();
  const step = stepByName(plan, "agent");
  const config = JSON.parse(step.env.OPENCODE_CONFIG_CONTENT);
  strictEqual(config.permission["*"], "allow", "tools auto-approve inside the worktree scope");
  strictEqual(config.permission.external_directory, "deny", "the worktree is the writable area");
  strictEqual(config.permission.bash["git push*"], "deny", "publishing is the orchestrator's job");
  strictEqual(config.permission.bash["gh pr create*"], "deny");
});

test("the prompt template interpolates only the issue number", () => {
  const { plan } = builtPlan({ issue: 40 });
  const prompt = stepByName(plan, "agent").args[1];
  match(prompt, /gh issue view 40 --comments/, "the agent reads the issue itself");
  match(prompt, /AGENT-SUMMARY\.md/, "the agent leaves a written summary");
  match(prompt, /never push/i, "publishing stays with the orchestrator");
  strictEqual(prompt.includes("undefined"), false);
  // Building the plan for a different issue changes the prompt only where
  // the issue number appears — nothing else is ever interpolated.
  const other = opencodeEngine.plan(planRequest({ issue: 41 }), {
    env: {},
    which: () => "opencode",
    tmpdir: () => "/tmp",
    worktreePath: "/tmp/workbench-issue-40-fixed",
    cleanupSpawn: () => ({ status: 0 }),
  });
  strictEqual(stepByName(other, "agent").args[1], prompt.replaceAll("40", "41"));
});

test("the commit step stages everything and attributes the producing CLI and model", () => {
  const { plan } = builtPlan();
  const add = stepByName(plan, "stage");
  const commit = stepByName(plan, "commit");
  deepStrictEqual(add.args, ["add", "-A"]);
  deepStrictEqual(add.cwd, "/tmp/workbench-issue-40-fixed");
  deepStrictEqual(commit.command, "git");
  strictEqual(commit.args[0], "commit");
  match(commit.args[2], /issue #40/);
  match(commit.args.join(" "), /opencode/, "the commit names the producing CLI");
  match(commit.args.join(" "), /ollama\/qwen3-coder:30b/, "the commit names the producing model");
});

test("the push step publishes only the agent branch", () => {
  const { plan } = builtPlan();
  const step = stepByName(plan, "push");
  deepStrictEqual(step.args, ["push", "-u", "origin", "agent/issue-40"]);
  deepStrictEqual(step.cwd, "/tmp/workbench-issue-40-fixed");
});

test("the pull-request step opens a draft PR whose body fixes the issue and names its provenance", () => {
  const { plan } = builtPlan();
  const step = stepByName(plan, "pull-request");
  deepStrictEqual(step.command, "gh");
  strictEqual(step.args[0], "pr");
  strictEqual(step.args[1], "create");
  deepStrictEqual(step.args[2], "--draft");
  const head = step.args[step.args.indexOf("--head") + 1];
  strictEqual(head, "agent/issue-40");
  const title = step.args[step.args.indexOf("--title") + 1];
  const body = step.args[step.args.indexOf("--body") + 1];
  match(title, /#40/);
  match(title, /opencode/);
  match(body, /Fixes #40/);
  match(body, /opencode/);
  match(body, /ollama\/qwen3-coder:30b/, "the PR names the model that produced it");
  match(body, /review/i, "the PR asks for human review");
});

test("a successful run's cleanup removes the worktree and the local branch; a failed run's does not", () => {
  const { plan, cleanupCalls } = builtPlan();
  plan.cleanup({ ok: true });
  deepStrictEqual(
    cleanupCalls,
    [
      {
        command: "git",
        args: ["worktree", "remove", "--force", "/tmp/workbench-issue-40-fixed"],
        cwd: "/host/repo",
      },
      {
        command: "git",
        args: ["branch", "-D", "agent/issue-40"],
        cwd: "/host/repo",
      },
    ],
    "the pushed branch's local twin is dropped, the PR keeps the remote one",
  );

  const { plan: failing, cleanupCalls: failingCalls } = builtPlan();
  failing.cleanup({ ok: false });
  deepStrictEqual(failingCalls, [], "a failed run keeps its worktree for inspection");
});

test("cleanup that fails is best-effort: it throws nothing and still tries the backstop removal", () => {
  const calls = [];
  const { plan } = builtPlan(
    {},
    {
      cleanupSpawn: ({ args }) => {
        calls.push(args.join(" "));
        return { status: 1, stderr: "contains modified or untracked files" };
      },
    },
  );
  plan.cleanup({ ok: true });
  match(calls.join(" "), /worktree remove --force/, "the git removal was attempted");
});

test("an unresolvable opencode binary yields a null plan, not a doomed one", () => {
  const plan = opencodeEngine.plan(planRequest(), {
    env: {},
    which: () => null,
    tmpdir: () => "/tmp",
    cleanupSpawn: () => ({ status: 0 }),
  });
  strictEqual(plan, null);
});

test("the env override pins the binary without consulting PATH", () => {
  const whichCalls = [];
  const { plan } = builtPlan(
    {},
    {
      env: { WORKBENCH_OPENCODE_BIN: "/opt/pinned/opencode" },
      which: (binary) => {
        whichCalls.push(binary);
        return "/usr/local/bin/opencode";
      },
    },
  );
  strictEqual(stepByName(plan, "agent").command, "/opt/pinned/opencode");
  deepStrictEqual(whichCalls, [], "an explicit pin never falls back to PATH");
});

test("the default worktree path is deterministic per issue, so retries start clean", () => {
  const plan = opencodeEngine.plan(planRequest({ issue: 7 }), {
    env: {},
    which: () => "opencode",
    tmpdir: () => "/var/folders/tmp",
    cleanupSpawn: () => ({ status: 0 }),
  });
  const worktreeCwd = stepByName(plan, "agent").cwd;
  strictEqual(worktreeCwd, "/var/folders/tmp/workbench-issue-7");
  strictEqual(worktreeCwd, stepByName(plan, "worktree").args[2]);
  strictEqual(stepByName(plan, "clear").args[3], worktreeCwd);
});

test("the agent step's timeout is generous by default and env-overridable", () => {
  const { plan } = builtPlan();
  const step = stepByName(plan, "agent");
  strictEqual(step.timeoutMs, 30 * 60_000, "unattended local runs get tens of minutes");

  const overridden = opencodeEngine.plan(planRequest(), {
    env: { WORKBENCH_OPENCODE_TIMEOUT_MS: "60000" },
    which: () => "opencode",
    tmpdir: () => "/tmp",
    worktreePath: "/tmp/wt",
    cleanupSpawn: () => ({ status: 0 }),
  });
  strictEqual(stepByName(overridden, "agent").timeoutMs, 60_000);
});

test("the agent step's output inspector surfaces permission and confirmation states", () => {
  const { plan } = builtPlan();
  const inspect = stepByName(plan, "agent").inspectLine;
  strictEqual(typeof inspect, "function");
  const denial = inspect('{"type":"permission","status":"denied","pattern":"git push*"}');
  match(denial, /permission/i, "a permission event becomes a notice");
  strictEqual(inspect("plain streaming text"), null, "ordinary text is not a notice");
  strictEqual(inspect('{"type":"step_start","part":{"type":"step_start"}}'), null);
  const stall = inspect('{"type":"question","part":{"type":"question"}}');
  match(stall, /attention|confirm|question/i, "a confirmation-like stall becomes a notice");
});

// --- The health half: one probe, the agent setup's whole story ---

const readyCli = () => ({
  "/usr/local/bin/opencode": (args) =>
    args[0] === "--version"
      ? { status: 0, stdout: "opencode 1.0.197\n", stderr: "" }
      : { status: 0, stdout: "", stderr: "" },
});

const healthCli = (script) => {
  const calls = [];
  const spawn = ({ command, args }) => {
    calls.push([command, ...args].join(" "));
    return script[command]?.(args) ?? { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
};

const pulledModels = ["qwen3-coder:30b", "llama3.2:latest"];

const probed = ({
  script = readyCli(),
  binary = "/usr/local/bin/opencode",
  tags = async () => pulledModels,
  env = { OLLAMA_CONTEXT_LENGTH: "32768" },
  which = () => binary,
} = {}) =>
  opencodeEngine.probeHealth({
    spawn: healthCli(script).spawn,
    ollama: { tags },
    env,
    which,
  });

test("a ready engine reports its version, the pulled models, and the default", async () => {
  const health = await probed();
  deepStrictEqual(health, {
    engine: "opencode",
    state: "ready",
    version: "opencode 1.0.197",
    models: pulledModels,
    defaultModel: defaultModel,
  });
  strictEqual("warning" in health, false, "a raised context length raises no warning");
});

test("a missing opencode binary reports binary_missing with the install command", async () => {
  const enoent = () => ({
    status: null,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }),
  });
  const health = await probed({ script: { opencode: enoent }, binary: "opencode" });
  deepStrictEqual(health, {
    engine: "opencode",
    state: "binary_missing",
    remediation: "install the opencode CLI: brew install opencode",
  });
});

test("a broken opencode binary reports probe_error with the CLI's own complaint", async () => {
  const health = await probed({
    script: {
      "/usr/local/bin/opencode": () => ({ status: 1, stdout: "", stderr: "config parse error" }),
    },
  });
  deepStrictEqual(health, {
    engine: "opencode",
    state: "probe_error",
    message: "config parse error",
  });
});

test("an unreachable ollama server reports ollama_unreachable with the start command", async () => {
  const health = await probed({
    tags: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  deepStrictEqual(health, {
    engine: "opencode",
    state: "ollama_unreachable",
    version: "opencode 1.0.197",
    remediation:
      "start the Ollama server (`ollama serve`) — the issue agent runs local models only",
  });
});

test("an unpulled default model reports model_missing with the pull command and the alternatives", async () => {
  const health = await probed({ tags: async () => ["llama3.2:latest"] });
  deepStrictEqual(health, {
    engine: "opencode",
    state: "model_missing",
    version: "opencode 1.0.197",
    model: defaultModel,
    models: ["llama3.2:latest"],
    remediation: `run \`ollama pull ${defaultModel.replace(/^ollama\//, "")}\`, or pick a pulled model in the panel`,
  });
});

test("the small default context length warns on an otherwise-ready engine", async () => {
  const health = await probed({ env: {} });
  strictEqual(health.state, "ready");
  match(health.warning, /OLLAMA_CONTEXT_LENGTH/);
  match(health.warning, /4096/, "the warning names the small default being used");
});

test("the env override steers the health probe to the pinned binary", async () => {
  const { spawn, calls } = healthCli({
    "/opt/pinned/opencode": (args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "opencode 9.9.9\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
  });
  const health = await opencodeEngine.probeHealth({
    spawn,
    ollama: { tags: async () => pulledModels },
    env: { OLLAMA_CONTEXT_LENGTH: "8192", WORKBENCH_OPENCODE_BIN: "/opt/pinned/opencode" },
  });
  strictEqual(health.state, "ready");
  strictEqual(health.version, "opencode 9.9.9");
  deepStrictEqual(calls, ["/opt/pinned/opencode --version"]);
});

test("the health probe never runs the agent", async () => {
  const { spawn, calls } = healthCli(readyCli());
  await opencodeEngine.probeHealth({
    spawn,
    ollama: { tags: async () => pulledModels },
    env: { OLLAMA_CONTEXT_LENGTH: "8192" },
    which: () => "/usr/local/bin/opencode",
  });
  strictEqual(
    calls.some((argv) => argv.split(" ").includes("run")),
    false,
  );
});
