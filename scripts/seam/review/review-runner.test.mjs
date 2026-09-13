import { deepStrictEqual, match, strictEqual } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reviewHealth, startReviewRun } from "./review-runner.mjs";

// The review runner seam's health half (epic #20, ticket #24). The spawn
// function is the seam's I/O boundary: fakes answer for the CLI binaries so
// the tests stay hermetic and never touch a real review tool. The fake
// records every argv it is asked to run, so the tests can also prove health
// probes never run a review.

const cli = (script) => {
  const calls = [];
  const spawn = ({ command, args }) => {
    calls.push([command, ...args].join(" "));
    return script[command]?.(...args) ?? { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
};

test("a found coderabbit binary with working auth reports the engine ready", async () => {
  const { spawn, calls } = cli({
    coderabbit: (arg) =>
      arg === "--version"
        ? { status: 0, stdout: "coderabbit 1.2.3\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
  });
  const health = await reviewHealth({ spawn, homedir: () => "/home/dev", which: () => null });
  deepStrictEqual(
    health.engines.find((e) => e.engine === "coderabbit"),
    {
      engine: "coderabbit",
      state: "ready",
      version: "coderabbit 1.2.3",
    },
  );
  // The exact probed argv, in order — this is what makes "health never runs
  // a review" hold: only version and auth subcommands are ever spawned.
  deepStrictEqual(calls, ["coderabbit --version", "coderabbit auth status", "zcode --version"]);
});

const enoent = () => ({
  status: null,
  stdout: "",
  stderr: "",
  error: Object.assign(new Error("spawn coderabbit ENOENT"), { code: "ENOENT" }),
});

test("a missing coderabbit binary reports binary_missing with the install command", async () => {
  const { spawn } = cli({ coderabbit: enoent });
  const health = await reviewHealth({ spawn, homedir: () => "/home/dev", which: () => null });
  deepStrictEqual(
    health.engines.find((e) => e.engine === "coderabbit"),
    {
      engine: "coderabbit",
      state: "binary_missing",
      remediation: "install the CodeRabbit CLI: brew install coderabbit",
    },
  );
});

test("an unauthenticated coderabbit CLI reports auth_missing with the login command", async () => {
  const { spawn } = cli({
    coderabbit: (arg) =>
      arg === "--version"
        ? { status: 0, stdout: "coderabbit 1.2.3\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "not logged in" },
  });
  const health = await reviewHealth({ spawn, homedir: () => "/home/dev", which: () => null });
  deepStrictEqual(
    health.engines.find((e) => e.engine === "coderabbit"),
    {
      engine: "coderabbit",
      state: "auth_missing",
      version: "coderabbit 1.2.3",
      remediation:
        "run `coderabbit auth login --api-key <your Agentic API key>` — headless reviews need the Agentic key",
    },
  );
});

test("a spawn-level failure of the auth probe reports probe_error, not auth_missing", async () => {
  // A timeout or unspawnable `auth status` is not the CLI answering "not
  // logged in"; telling the Developer to run the login command would be the
  // opaque misdirection this ticket exists to prevent. The fake answers with
  // spawnSync's real failure shape: status null and stdout/stderr null.
  const { spawn } = cli({
    coderabbit: (arg) =>
      arg === "--version"
        ? { status: 0, stdout: "coderabbit 1.2.3\n", stderr: "" }
        : {
            status: null,
            stdout: null,
            stderr: null,
            error: Object.assign(new Error("spawn coderabbit EACCES"), { code: "EACCES" }),
          },
  });
  const health = await reviewHealth({ spawn, homedir: () => "/home/dev", which: () => null });
  const coderabbit = health.engines.find((e) => e.engine === "coderabbit");
  strictEqual(coderabbit.state, "probe_error");
  match(coderabbit.message, /EACCES/);
});

const zcodeCli = () =>
  cli({
    zcode: (arg) =>
      arg === "--version"
        ? { status: 0, stdout: "0.16.5\n", stderr: "" }
        : { status: 0, stdout: "", stderr: "" },
  });

const homeWithProviderConfig = async () => {
  const home = await mkdtemp(join(tmpdir(), "review-runner-home-"));
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(
    join(home, ".zcode", "cli", "config.json"),
    JSON.stringify({ model: "glm-4.7", provider: "zai" }),
  );
  return home;
};

test("a found zcode binary with a provider config reports the engine ready", async () => {
  const { spawn, calls } = zcodeCli();
  const home = await homeWithProviderConfig();
  const health = await reviewHealth({ spawn, homedir: () => home, which: () => null });
  deepStrictEqual(
    health.engines.find((e) => e.engine === "zcode"),
    {
      engine: "zcode",
      state: "ready",
      version: "0.16.5",
    },
  );
  strictEqual(
    calls.some((argv) => argv.includes("--prompt")),
    false,
    "health never runs a prompt",
  );
});

test("zcode without a model provider config reports provider_missing with the login command", async () => {
  const { spawn } = zcodeCli();
  const home = await mkdtemp(join(tmpdir(), "review-runner-home-"));
  const health = await reviewHealth({ spawn, homedir: () => home, which: () => null });
  deepStrictEqual(
    health.engines.find((e) => e.engine === "zcode"),
    {
      engine: "zcode",
      state: "provider_missing",
      version: "0.16.5",
      remediation: "run `zcode login` to configure a model provider",
    },
  );
});

test("a missing zcode binary reports binary_missing instead of touching a config", async () => {
  const { spawn } = cli({ zcode: enoent });
  const health = await reviewHealth({
    spawn,
    homedir: () => "/home/never-checked",
    which: () => null,
  });
  deepStrictEqual(
    health.engines.find((e) => e.engine === "zcode"),
    {
      engine: "zcode",
      state: "binary_missing",
      remediation: "install the ZCode desktop app — the zcode CLI ships inside it",
    },
  );
});

test("a present but broken binary reports probe_error with the CLI's own complaint", async () => {
  const { spawn } = cli({
    coderabbit: () => ({ status: 1, stdout: "", stderr: "syntax error near unexpected token" }),
    zcode: () => ({ status: 1, stdout: "", stderr: "syntax error near unexpected token" }),
  });
  const health = await reviewHealth({ spawn, homedir: () => "/home/dev", which: () => null });
  // The review engines both answer with the CLI's own complaint; the opencode
  // engine (which: null here) never reaches a binary at all.
  for (const name of ["coderabbit", "zcode"]) {
    const engine = health.engines.find((e) => e.engine === name);
    strictEqual(engine.state, "probe_error");
    strictEqual(engine.message, "syntax error near unexpected token");
  }
});

test("a spawn-level failure (not a CLI exit) reports probe_error with the spawn's complaint", async () => {
  const { spawn } = cli({
    coderabbit: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
    }),
  });
  const health = await reviewHealth({ spawn, homedir: () => "/home/dev", which: () => null });
  const coderabbit = health.engines.find((e) => e.engine === "coderabbit");
  strictEqual(coderabbit.state, "probe_error");
  strictEqual(coderabbit.message, "spawn EACCES");
});

test("a binary that vanishes between the version and auth probes still reads binary_missing", async () => {
  const { spawn } = cli({
    coderabbit: (arg) =>
      arg === "--version" ? { status: 0, stdout: "coderabbit 1.2.3\n", stderr: "" } : enoent(),
  });
  const health = await reviewHealth({ spawn, homedir: () => "/home/dev", which: () => null });
  deepStrictEqual(
    health.engines.find((e) => e.engine === "coderabbit"),
    {
      engine: "coderabbit",
      state: "binary_missing",
      remediation: "install the CodeRabbit CLI: brew install coderabbit",
    },
  );
});

test("health answers for all engines in a fixed order", async () => {
  const { spawn } = cli({
    coderabbit: () => enoent(),
    zcode: () => enoent(),
  });
  const health = await reviewHealth({ spawn, homedir: () => "/home/dev", which: () => null });
  deepStrictEqual(
    health.engines.map((engine) => engine.engine),
    ["coderabbit", "zcode", "opencode"],
  );
});

// --- The run half (ticket #26): cancel, single-run, timeout, output caps ---

// A fake child in the run spawn contract's shape: stdout/stderr as async
// iterables, a kill that records signals (optionally ignoring SIGTERM to
// exercise the escalation to SIGKILL), and an `exited` promise the runner
// observes for the run's end. Like a real CLI, it exits by itself once both
// streams have drained — unless autoExit is off for tests that drive the
// exit through kill or an explicit timeout. Every ending closes the
// streams before the exit resolves, mirroring close-after-stdio.
const fakeChild = ({ stdout = [], stderr = [], ignoreSigterm = false, autoExit = true } = {}) => {
  let exitResolve;
  const child = {
    pid: 4242,
    signals: [],
    closed: false,
    exited: new Promise((resolve) => (exitResolve = resolve)),
    kill(signal) {
      child.signals.push(signal);
      if (signal === "SIGTERM" && ignoreSigterm) return true;
      child.endWith({ code: null, signal: signal ?? null });
      return true;
    },
    exitNow(exit = { code: 0, signal: null }) {
      child.endWith(exit);
    },
    endWith(exit) {
      child.closed = true;
      // The real adapter's close fires only after the stdio streams have
      // ended; deferring to a macrotask keeps that ordering honest.
      setImmediate(() => exitResolve(exit));
    },
  };
  let open = 2;
  const drained = () => {
    open -= 1;
    if (open === 0 && autoExit) child.endWith({ code: 0, signal: null });
  };
  child.stdout = stringStream(stdout, () => child.closed, drained);
  child.stderr = stringStream(stderr, () => child.closed, drained);
  return child;
};

const stringStream = async function* (chunks, isClosed, done) {
  for (const chunk of chunks) {
    if (isClosed()) return;
    yield chunk;
    if (isClosed()) return;
  }
  done?.();
};

const spawned = (child) => {
  const calls = [];
  const spawn = (request) => {
    calls.push(request);
    return child;
  };
  return { spawn, calls };
};

const collect = async (run) => {
  const events = [];
  for await (const event of run.events) events.push(event);
  return events;
};

test("a run streams started, the CLI's output, and its exit", async () => {
  const { spawn, calls } = spawned(fakeChild({ stdout: ["finding one\n", "finding two\n"] }));
  const run = startReviewRun({
    engine: "coderabbit",
    pr: 42,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
  });

  const events = await collect(run);
  deepStrictEqual(events, [
    { type: "started", engine: "coderabbit", pr: 42 },
    { type: "output", stream: "stdout", text: "finding one\n" },
    { type: "output", stream: "stdout", text: "finding two\n" },
    { type: "exit", code: 0, signal: null, cancelled: false },
  ]);
  strictEqual(calls.length, 1);
  strictEqual(calls[0].command, "coderabbit");
});

test("a run that exits non-zero still ends with its exit code", async () => {
  const child = fakeChild({ stderr: ["boom\n"], autoExit: false });
  const { spawn } = spawned(child);
  const run = startReviewRun({
    engine: "zcode",
    pr: 7,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
  });
  const collected = collect(run);
  child.exitNow({ code: 1, signal: null });
  const events = await collected;
  deepStrictEqual(events.at(-1), { type: "exit", code: 1, signal: null, cancelled: false });
  strictEqual(
    events.some((event) => event.type === "output" && event.text === "boom\n"),
    true,
  );
});

test("cancelling a run kills the CLI and marks the exit as cancelled", async () => {
  const child = fakeChild({ autoExit: false });
  const { spawn } = spawned(child);
  const run = startReviewRun({
    engine: "coderabbit",
    pr: 42,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
  });
  run.cancel();

  const events = await collect(run);
  deepStrictEqual(child.signals, ["SIGTERM"]);
  deepStrictEqual(events.at(-1), { type: "exit", code: null, signal: "SIGTERM", cancelled: true });
});

test("a CLI that ignores SIGTERM is escalated to SIGKILL", async () => {
  const child = fakeChild({ ignoreSigterm: true, autoExit: false });
  const { spawn } = spawned(child);
  const run = startReviewRun({
    engine: "coderabbit",
    pr: 42,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
    terminateGraceMs: 20,
  });
  run.cancel();

  const events = await collect(run);
  deepStrictEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  deepStrictEqual(events.at(-1), { type: "exit", code: null, signal: "SIGKILL", cancelled: true });
});

test("a run that exceeds the time limit ends with a timeout error", async () => {
  const child = fakeChild({ ignoreSigterm: true, autoExit: false }); // hung CLI
  const { spawn } = spawned(child);
  const run = startReviewRun({
    engine: "coderabbit",
    pr: 42,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
    timeoutMs: 20,
    terminateGraceMs: 5,
  });

  const events = await collect(run);
  const timeout = events.find((event) => event.type === "error");
  strictEqual(timeout.reason, "timeout");
  deepStrictEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  deepStrictEqual(events.at(-1), { type: "exit", code: null, signal: "SIGKILL", cancelled: false });
});

test("an explicit cancel during a timeout stop escalates only once", async () => {
  const child = fakeChild({ ignoreSigterm: true, autoExit: false });
  const { spawn } = spawned(child);
  const run = startReviewRun({
    engine: "coderabbit",
    pr: 42,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
    timeoutMs: 20,
    terminateGraceMs: 10,
  });
  // The timeout stops the run at ~20ms; a user cancel arriving before the
  // exit must not schedule a second SIGKILL cycle.
  setTimeout(() => run.cancel(), 22);
  const events = await collect(run);

  deepStrictEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  strictEqual(events.filter((event) => event.type === "error").length, 1);
});

test("output beyond the cap truncates once with a distinct marker", async () => {
  const child = fakeChild({ stdout: ["a".repeat(600) + "\n", "b".repeat(600) + "\n"] });
  const { spawn } = spawned(child);
  const run = startReviewRun({
    engine: "coderabbit",
    pr: 42,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
    outputCapBytes: 700,
  });

  const events = await collect(run);
  const outputEvents = events.filter((event) => event.type === "output");
  strictEqual(
    outputEvents.reduce((total, event) => total + Buffer.byteLength(event.text), 0) <= 700,
    true,
    "output stops at the cap",
  );
  deepStrictEqual(
    events.filter((event) => event.type === "truncated"),
    [{ type: "truncated" }],
    "exactly one truncation marker",
  );
  deepStrictEqual(events.at(-1), { type: "exit", code: 0, signal: null, cancelled: false });
});

test("the output cap is aggregate across both streams", async () => {
  // stdout and stderr each push 600 bytes against a 700-byte cap: neither
  // stream truncates alone, but together they do — once.
  const child = fakeChild({ stdout: ["a".repeat(600) + "\n"], stderr: ["b".repeat(600) + "\n"] });
  const { spawn } = spawned(child);
  const run = startReviewRun({
    engine: "coderabbit",
    pr: 42,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
    outputCapBytes: 700,
  });

  const events = await collect(run);
  deepStrictEqual(
    events.filter((event) => event.type === "truncated"),
    [{ type: "truncated" }],
    "exactly one truncation marker for the whole run",
  );
  const forwarded = events
    .filter((event) => event.type === "output")
    .reduce((total, event) => total + Buffer.byteLength(event.text), 0);
  strictEqual(forwarded <= 700, true, "the run forwards no more than the cap in total");
  deepStrictEqual(events.at(-1), { type: "exit", code: 0, signal: null, cancelled: false });
});

test("output chunks splitting a multi-byte character decode as one character", async () => {
  // A CLI streaming JSON emits bytes, not characters: "ü" is two UTF-8
  // bytes, and a chunk boundary between them must not become two
  // replacement characters in the panel.
  const line = Buffer.from("finding: ü\n", "utf8");
  const { spawn } = spawned(fakeChild({ stdout: [line.subarray(0, 10), line.subarray(10)] }));
  const run = startReviewRun({
    engine: "coderabbit",
    pr: 42,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
  });

  const events = await collect(run);
  const text = events
    .filter((event) => event.type === "output")
    .map((event) => event.text)
    .join("");
  strictEqual(text, "finding: ü\n");
});

test("the enumerated run commands never accept arbitrary strings from the page", async () => {
  const child = fakeChild();
  const { spawn, calls } = spawned(child);
  const run = startReviewRun({
    engine: "zcode",
    pr: 99,
    baseBranch: "main",
    hostRepoRoot: "/host/repo",
    spawn,
  });
  const collected = collect(run);
  child.exitNow();
  await collected;

  strictEqual(calls[0].command, "zcode");
  strictEqual(calls[0].cwd, "/host/repo", "the run executes in the host repo");
  strictEqual(
    calls[0].args.includes("--mode") && calls[0].args[calls[0].args.indexOf("--mode") + 1],
    "plan",
    "zcode runs read-only plan mode",
  );
  strictEqual(
    calls[0].args.some((arg) => typeof arg === "string" && arg.includes("99")),
    true,
    "the PR number rides the fixed prompt template",
  );
});

// --- The plan half (issue #40): multi-step engines run through the same seam ---

import { inspectAgentLine, opencodeRunCommand } from "./opencode-engine.mjs";

// Unlike the single-command reviews above, a plan spawns several children in
// sequence: each spawn request gets its own fake child, and every request is
// recorded so the tests can pin argv, cwd, and env per step.
const spawnEach = (children) => {
  const calls = [];
  const spawn = (request) => {
    calls.push(request);
    const child = children[Math.min(calls.length - 1, children.length - 1)];
    return child;
  };
  return { spawn, calls };
};

const stepPlan = (cleanupCalls = []) => ({
  steps: [
    { name: "worktree", command: "git", args: ["worktree", "add"], cwd: "/host/repo" },
    {
      name: "agent",
      command: "opencode",
      args: ["run"],
      cwd: "/tmp/wt",
      inspectLine: inspectAgentLine,
    },
    { name: "publish", command: "gh", args: ["pr", "create"], cwd: "/tmp/wt" },
  ],
  cleanup: ({ ok }) => cleanupCalls.push(ok),
});

test("a plan runs its steps in order, each with its own argv, cwd, and env", async () => {
  const children = [fakeChild(), fakeChild(), fakeChild()];
  const { spawn, calls } = spawnEach(children);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    baseBranch: "origin/main",
    hostRepoRoot: "/host/repo",
    spawn,
    runCommands: { opencode: () => stepPlan() },
  });

  const events = await collect(run);
  deepStrictEqual(events[0], {
    type: "started",
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
  });
  deepStrictEqual(events.at(-1), { type: "exit", code: 0, signal: null, cancelled: false });
  deepStrictEqual(
    calls.map((call) => [call.command, call.cwd]),
    [
      ["git", "/host/repo"],
      ["opencode", "/tmp/wt"],
      ["gh", "/tmp/wt"],
    ],
  );
  deepStrictEqual(
    children.every((child) => child.signals.length === 0),
    true,
  );
});

test("a failing step stops the plan, reports step_failed, and still runs cleanup", async () => {
  const cleanupCalls = [];
  const hung = fakeChild({ autoExit: false });
  const children = [fakeChild(), fakeChild({ stderr: ["conflict\n"], autoExit: false }), hung];
  const { spawn, calls } = spawnEach(children);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    hostRepoRoot: "/host/repo",
    spawn,
    runCommands: { opencode: () => stepPlan(cleanupCalls) },
  });
  // The failing step's child decides its own exit; the third step must never
  // spawn, and its (hung) child is left untouched.
  setImmediate(() => children[1].exitNow({ code: 1, signal: null }));

  const events = await collect(run);
  deepStrictEqual(
    events.filter((event) => event.type === "error"),
    [
      {
        type: "error",
        reason: "step_failed",
        message: "the opencode agent step failed with exit code 1",
      },
    ],
  );
  deepStrictEqual(events.at(-1), { type: "exit", code: 1, signal: null, cancelled: false });
  deepStrictEqual(cleanupCalls, [false], "a failed run's cleanup knows the plan failed");
  strictEqual(calls.length, 2, "the step after the failure never spawns");
  strictEqual(hung.signals.length, 0);
});

test("a best-effort step's failure neither stops the plan nor fails the run", async () => {
  // The clearing step fails whenever no leftover worktree exists — a first
  // run must proceed exactly like a retry.
  const cleanupCalls = [];
  const clearing = fakeChild({ autoExit: false });
  const { spawn, calls } = spawnEach([clearing, fakeChild()]);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    hostRepoRoot: "/host/repo",
    spawn,
    runCommands: {
      opencode: () => ({
        steps: [
          { name: "clear", command: "git", args: ["worktree", "remove"], bestEffort: true },
          { name: "worktree", command: "git", args: ["worktree", "add"] },
        ],
        cleanup: ({ ok }) => cleanupCalls.push(ok),
      }),
    },
  });

  setImmediate(() => clearing.exitNow({ code: 1, signal: null }));

  const events = await collect(run);
  deepStrictEqual(
    calls.map((call) => call.command),
    ["git", "git"],
  );
  deepStrictEqual(
    events.filter((event) => event.type === "error"),
    [],
    "a best-effort failure is not a run error",
  );
  deepStrictEqual(events.at(-1), { type: "exit", code: 0, signal: null, cancelled: false });
  deepStrictEqual(cleanupCalls, [true]);
});

test("a completed plan's cleanup learns the plan succeeded", async () => {
  const cleanupCalls = [];
  const { spawn } = spawnEach([fakeChild(), fakeChild(), fakeChild()]);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    hostRepoRoot: "/host/repo",
    spawn,
    runCommands: { opencode: () => stepPlan(cleanupCalls) },
  });
  await collect(run);
  deepStrictEqual(cleanupCalls, [true]);
});

test("cancelling a plan run kills the current step and skips the rest", async () => {
  const cleanupCalls = [];
  const hung = fakeChild({ autoExit: false });
  const { spawn, calls } = spawnEach([fakeChild(), hung]);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    hostRepoRoot: "/host/repo",
    spawn,
    runCommands: { opencode: () => stepPlan(cleanupCalls) },
  });
  // Cancel once the second step is the one running.
  await new Promise((resolve) => setTimeout(resolve, 10));
  run.cancel();

  const events = await collect(run);
  deepStrictEqual(hung.signals, ["SIGTERM"]);
  deepStrictEqual(events.at(-1), { type: "exit", code: null, signal: "SIGTERM", cancelled: true });
  deepStrictEqual(cleanupCalls, [false]);
  strictEqual(calls.length, 2, "no step spawns after the cancel");
});

test("a plan step that outlives its time limit fails the run and proceeds to cleanup", async () => {
  const cleanupCalls = [];
  const hung = fakeChild({ ignoreSigterm: true, autoExit: false });
  const { spawn, calls } = spawnEach([fakeChild(), hung]);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    hostRepoRoot: "/host/repo",
    spawn,
    timeoutMs: 20,
    terminateGraceMs: 5,
    runCommands: { opencode: () => stepPlan(cleanupCalls) },
  });

  const events = await collect(run);
  const timeout = events.find((event) => event.type === "error");
  strictEqual(timeout.reason, "timeout");
  match(timeout.message, /agent step/, "the timeout names the step that hung");
  deepStrictEqual(hung.signals, ["SIGTERM", "SIGKILL"]);
  deepStrictEqual(events.at(-1), { type: "exit", code: null, signal: "SIGKILL", cancelled: false });
  deepStrictEqual(cleanupCalls, [false]);
  strictEqual(calls.length, 2, "the step after the timeout never spawns");
});

test("the plan's output inspector turns agent JSON events into notices", async () => {
  const children = [
    fakeChild(),
    fakeChild({
      stdout: [
        '{"type":"step_start"}\n',
        '{"type":"permission","status":"denied","pattern":"git push*"}\n',
      ],
    }),
    fakeChild(),
  ];
  const { spawn } = spawnEach(children);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    hostRepoRoot: "/host/repo",
    spawn,
    runCommands: { opencode: () => stepPlan() },
  });

  const events = await collect(run);
  deepStrictEqual(
    events.filter((event) => event.type === "notice"),
    [{ type: "notice", message: "agent permission event: permission (git push*)" }],
  );
});

test("an unavailable engine (null plan) ends with a typed error and never spawns", async () => {
  const { spawn, calls } = spawnEach([fakeChild()]);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    hostRepoRoot: "/host/repo",
    spawn,
    runCommands: { opencode: () => null },
  });

  const events = await collect(run);
  deepStrictEqual(events, [
    { type: "started", engine: "opencode", issue: 40, model: "ollama/qwen3-coder:30b" },
    {
      type: "error",
      reason: "engine_unavailable",
      message: "the opencode engine did not produce a run — its CLI may be missing",
    },
    { type: "exit", code: null, signal: null, cancelled: false },
  ]);
  deepStrictEqual(calls, [], "no worktree, no agent, no publish");
});

test("the opencode engine's real plan reaches the runner's step loop", async () => {
  // The registration seam: the entry the runner registers builds the engine's
  // own plan (argv pinned by the engine's tests) and executes it here with a
  // pinned binary so the test stays hermetic.
  const children = [
    fakeChild(),
    fakeChild(),
    fakeChild(),
    fakeChild(),
    fakeChild(),
    fakeChild(),
    fakeChild(),
  ];
  const { spawn, calls } = spawnEach(children);
  const run = startReviewRun({
    engine: "opencode",
    issue: 40,
    model: "ollama/qwen3-coder:30b",
    baseBranch: "origin/main",
    hostRepoRoot: "/host/repo",
    spawn,
    runCommands: {
      opencode: (request) =>
        opencodeRunCommand(request, { WORKBENCH_OPENCODE_BIN: "/opt/pinned/opencode" }),
    },
  });

  const events = await collect(run);
  strictEqual(events.at(-1).code, 0);
  deepStrictEqual(
    calls.map((call) => call.command),
    ["git", "git", "/opt/pinned/opencode", "git", "git", "git", "gh"],
  );
  strictEqual(calls[2].env.OPENCODE_CONFIG_CONTENT.length > 0, true, "the agent rides the fence");
});

test("the registered opencode entry resolves the binary through the engine", () => {
  strictEqual(
    opencodeRunCommand({ issue: 40, hostRepoRoot: "/h", baseBranch: "origin/main" }, {}),
    null,
  );
  const plan = opencodeRunCommand(
    { issue: 40, hostRepoRoot: "/h", baseBranch: "origin/main" },
    { WORKBENCH_OPENCODE_BIN: "/opt/x" },
  );
  strictEqual(plan.steps.length, 7);
  strictEqual(plan.steps[2].command, "/opt/x");
});

test("the opencode entry fills the default model from the environment", () => {
  const envPinned = opencodeRunCommand(
    { issue: 40, hostRepoRoot: "/h", baseBranch: "origin/main" },
    { WORKBENCH_OPENCODE_BIN: "/opt/x", WORKBENCH_OPENCODE_MODEL: "ollama/llama3.2:latest" },
  );
  const pinnedArgs = envPinned.steps[2].args;
  strictEqual(pinnedArgs[pinnedArgs.indexOf("--model") + 1], "ollama/llama3.2:latest");
  const fallbackArgs = opencodeRunCommand(
    { issue: 40, hostRepoRoot: "/h", baseBranch: "origin/main" },
    { WORKBENCH_OPENCODE_BIN: "/opt/x" },
  ).steps[2].args;
  strictEqual(fallbackArgs[fallbackArgs.indexOf("--model") + 1], "ollama/qwen3-coder:30b");
});
