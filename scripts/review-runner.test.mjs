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
  const health = reviewHealth({ spawn, homedir: () => "/home/dev" });
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
  const health = reviewHealth({ spawn, homedir: () => "/home/dev" });
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
  const health = reviewHealth({ spawn, homedir: () => "/home/dev" });
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
  const health = reviewHealth({ spawn, homedir: () => "/home/dev" });
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
  const health = reviewHealth({ spawn, homedir: () => home });
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
  const health = reviewHealth({ spawn, homedir: () => home });
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
  const health = reviewHealth({ spawn, homedir: () => "/home/never-checked" });
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
  const health = reviewHealth({ spawn, homedir: () => "/home/dev" });
  for (const engine of health.engines) {
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
  const health = reviewHealth({ spawn, homedir: () => "/home/dev" });
  const coderabbit = health.engines.find((e) => e.engine === "coderabbit");
  strictEqual(coderabbit.state, "probe_error");
  strictEqual(coderabbit.message, "spawn EACCES");
});

test("a binary that vanishes between the version and auth probes still reads binary_missing", async () => {
  const { spawn } = cli({
    coderabbit: (arg) =>
      arg === "--version" ? { status: 0, stdout: "coderabbit 1.2.3\n", stderr: "" } : enoent(),
  });
  const health = reviewHealth({ spawn, homedir: () => "/home/dev" });
  deepStrictEqual(
    health.engines.find((e) => e.engine === "coderabbit"),
    {
      engine: "coderabbit",
      state: "binary_missing",
      remediation: "install the CodeRabbit CLI: brew install coderabbit",
    },
  );
});

test("health answers for both engines in a fixed order", async () => {
  const { spawn } = cli({
    coderabbit: () => enoent(),
    zcode: () => enoent(),
  });
  const health = reviewHealth({ spawn, homedir: () => "/home/dev" });
  deepStrictEqual(
    health.engines.map((engine) => engine.engine),
    ["coderabbit", "zcode"],
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
  const spawn = ({ command, args, options }) => {
    calls.push({ command, args, options });
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
