import { spawnSync, spawn as spawnChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

import { ollamaTagsLoader, opencodeEngine, opencodeRunCommand } from "./opencode-engine.mjs";

// The review runner seam (epic #20): the one component that knows how to
// execute a review and probe the review engines' health. This is the seam's
// health half (ticket #24): per-engine availability — CLI binary found (with
// its version), authentication / provider status — as typed states: not-ready
// states carry a one-step remediation command, except probe_error, which
// carries the probe's own message. Probes only ever invoke version and auth
// subcommands, never a review, and are safe to call repeatedly. The child-
// process spawn function is injected so tests substitute a fake CLI binary;
// the endpoint and the UI are thin layers over this module.

// The spawn contract: `spawn({ command, args })` runs the CLI and returns
// `{ status, stdout, stderr, error? }` — spawnSync's natural shape. The
// timeout bounds how long a hung CLI can block the dev server's event loop
// (spawnSync is synchronous by definition); the version/auth subcommands
// answer in milliseconds.
const nodeSpawn = ({ command, args }) =>
  spawnSync(command, args, { encoding: "utf8", timeout: 5_000 });

// Classifies a version probe: the binary is either found (with its version
// string), missing (ENOENT — also when it vanishes between probes), or
// present but failing (a CLI exit carries stderr; a spawn-level failure
// carries the spawn error's own message). A failed spawn returns stdout and
// stderr as null, not empty strings, so both reads are null-safe.
const versionProbe = ({ spawn, binary }) => {
  const result = spawn({ command: binary, args: ["--version"] });
  if (result.error?.code === "ENOENT") return { kind: "binary_missing" };
  if (result.status !== 0)
    return {
      kind: "probe_error",
      message:
        (result.stderr ?? "").trim() ||
        result.error?.message ||
        `${binary} --version exited with status ${result.status}`,
    };
  return { kind: "found", version: (result.stdout ?? "").trim() };
};

const binaryMissing = (engine, remediation) => ({ engine, state: "binary_missing", remediation });
const probeError = (engine, message) => ({ engine, state: "probe_error", message });

const coderabbitEngine = {
  name: "coderabbit",
  // Docs: docs.coderabbit.ai/cli — `coderabbit auth status` checks the
  // stored Agentic API key without touching the network side of a review.
  probeHealth({ spawn }) {
    const install = "install the CodeRabbit CLI: brew install coderabbit";
    const login =
      "run `coderabbit auth login --api-key <your Agentic API key>` — headless reviews need the Agentic key";
    const probe = versionProbe({ spawn, binary: "coderabbit" });
    if (probe.kind === "binary_missing") return binaryMissing("coderabbit", install);
    if (probe.kind === "probe_error") return probeError("coderabbit", probe.message);
    const auth = spawn({ command: "coderabbit", args: ["auth", "status"] });
    // The binary can vanish between the version and auth probes; anything
    // else that fails to spawn (timeout, EACCES) is the environment, not an
    // answer, so it surfaces as probe_error rather than a login instruction
    // the Developer can't act on.
    if (auth.error?.code === "ENOENT") return binaryMissing("coderabbit", install);
    if (auth.status === null || auth.error)
      return probeError(
        "coderabbit",
        (auth.stderr ?? "").trim() || auth.error?.message || "coderabbit auth status failed",
      );
    if (auth.status !== 0)
      return {
        engine: "coderabbit",
        state: "auth_missing",
        version: probe.version,
        remediation: login,
      };
    return { engine: "coderabbit", state: "ready", version: probe.version };
  },
};

const zcodeEngine = {
  name: "zcode",
  // Docs: the zcode headless failure mode is `Model config is missing. Create
  // ~/.zcode/cli/config.json with an explicit model provider` — the config
  // file's presence is the provider check, and `zcode login` writes it.
  probeHealth({ spawn, homedir }) {
    const probe = versionProbe({ spawn, binary: "zcode" });
    if (probe.kind === "binary_missing")
      return binaryMissing(
        "zcode",
        "install the ZCode desktop app — the zcode CLI ships inside it",
      );
    if (probe.kind === "probe_error") return probeError("zcode", probe.message);
    if (!existsSync(join(homedir(), ".zcode", "cli", "config.json")))
      return {
        engine: "zcode",
        state: "provider_missing",
        version: probe.version,
        remediation: "run `zcode login` to configure a model provider",
      };
    return { engine: "zcode", state: "ready", version: probe.version };
  },
};

// The engine registry: health probes for every engine, and a run command (or,
// for the issue-agent engine, a whole plan) per engine. The opencode entry is
// the first plan-shaped engine (issue #40); coderabbit and zcode stay single
// commands and the runner normalizes them into one-step plans.
const engines = [coderabbitEngine, zcodeEngine, opencodeEngine];

export const reviewHealth = async ({
  spawn = nodeSpawn,
  homedir = osHomedir,
  ollama = { tags: ollamaTagsLoader() },
  which,
} = {}) => ({
  // The opencode probe answers over HTTP (the local model server), so the
  // probe array resolves asynchronously; the coderabbit and zcode probes
  // resolve in place.
  engines: await Promise.all(
    engines.map((engine) => engine.probeHealth({ spawn, homedir, ollama, which })),
  ),
});

// --- The run half (ticket #26): cancel, single-run, timeout, output caps ---

// The enumerated review commands (epic #20): engine + PR number in, a fixed
// argv out — no shell, and no string ever accepted from the page. The
// coderabbit run still lacks its temporary worktree staging of the PR head
// (the run tickets, #22/#23); until then both engines execute with the host
// repo as their working directory.
const zcodeReviewPrompt = (pr) =>
  `Review pull request #${pr} in read-only planning mode: report findings, never modify files.`;

const runCommand = {
  coderabbit: ({ baseBranch }) => ({
    command: "coderabbit",
    args: ["review", "--agent", "--base", baseBranch],
  }),
  zcode: ({ pr, hostRepoRoot }) => ({
    command: "zcode",
    args: ["--prompt", zcodeReviewPrompt(pr), "--mode", "plan", "--cwd", hostRepoRoot, "--json"],
  }),
  opencode: opencodeRunCommand,
};

// Production spawn adapter: node's spawn with a detached process group, so
// kills reach the whole CLI process tree and not just the direct child; the
// child is surfaced in the runner's contract shape (async-iterable stdio and
// an `exited` promise, since the run consumes the process by subscription).
const nodeRunSpawn = ({ command, args, cwd, env }) => {
  const child = spawnChildProcess(command, args, {
    cwd,
    // A step's own env rides on top of the inherited environment — it carries
    // configuration (the permission fence), never a stripped-down PATH.
    env: env ? { ...process.env, ...env } : undefined,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolveExit) => {
    child.once("close", (code, signal) => resolveExit({ code, signal }));
    child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
  });
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    // The negative pid signals the process group — that is the tree kill.
    kill: (signal) => {
      try {
        return process.kill(-child.pid, signal);
      } catch {
        return child.kill(signal);
      }
    },
    exited,
  };
};

// One ordered event channel between the run's concurrent sources (two
// output streams, the exit, the timers) and the single consumer.
const eventChannel = () => {
  // Drained by read index rather than shift(): a CLI can emit many small
  // chunks, and shift-per-event turns that quadratic.
  const items = [];
  let head = 0;
  let wakeup = null;
  let closed = false;
  return {
    push(event) {
      if (closed) return;
      items.push(event);
      wakeup?.();
      wakeup = null;
    },
    close() {
      closed = true;
      wakeup?.();
      wakeup = null;
    },
    async *stream() {
      while (true) {
        while (head < items.length) {
          const event = items[head];
          items[head] = undefined;
          head += 1;
          yield event;
        }
        // Fully drained: compact the backing array, which would otherwise
        // grow for the run's lifetime under many-small-chunk output.
        items.length = 0;
        head = 0;
        if (closed) return;
        await new Promise((resolve) => (wakeup = resolve));
      }
    },
  };
};

export const startReviewRun = ({
  engine,
  pr,
  issue,
  model,
  baseBranch,
  hostRepoRoot,
  spawn = nodeRunSpawn,
  runCommands = runCommand,
  timeoutMs = 15 * 60_000,
  outputCapBytes = 1_000_000,
  terminateGraceMs = 5_000,
}) => {
  const channel = eventChannel();
  // The started event echoes the enumerated request — the PR number for the
  // review engines, the issue and model for the issue agent (issue #40).
  channel.push(
    pr !== undefined
      ? { type: "started", engine, pr }
      : { type: "started", engine, issue, ...(model !== undefined ? { model } : {}) },
  );

  let cancelled = false;
  let ended = false;
  let timedOut = false;
  let timeoutTimer = null;
  let graceTimer = null;
  let currentChild = null;

  // Stopping escalates: SIGTERM asks the CLI to stop, and a CLI that
  // ignores it is killed outright once the grace period passes. The
  // escalation is scheduled at most once per run — a late SIGKILL against a
  // recycled pid is the bug it exists to prevent — and targets the child
  // that was current when the stop began, never a later step's.
  let stopping = false;
  const stopProcess = () => {
    if (stopping) return;
    stopping = true;
    const target = currentChild;
    const signalTree = (signal) => {
      try {
        target?.kill(signal);
      } catch {
        // The child already exited between checks; nothing left to kill.
      }
    };
    signalTree("SIGTERM");
    graceTimer = setTimeout(() => signalTree("SIGKILL"), terminateGraceMs);
  };
  const cancel = () => {
    if (ended || cancelled) return;
    cancelled = true;
    stopProcess();
  };

  // The cap is the run's, not a stream's and not a step's: every stdout and
  // stderr of the whole plan shares one byte budget and one truncation
  // marker. The chunk that crosses the cap is forwarded up to the last byte
  // that fits, and once truncated the remaining chunks are dropped without
  // conversion.
  let bytes = 0;
  let truncated = false;
  const readStream = async (stream, name, step) => {
    // Multi-byte UTF-8 sequences can straddle chunk boundaries, so each
    // stream decodes through its own stateful decoder; the byte accounting
    // stays on the raw buffer. The pending sequence of a truncated stream
    // never completes — it is discarded with the rest of the drop.
    const decoder = new StringDecoder("utf8");
    // Complete lines of a step that carries an inspector become notices
    // (issue #40: permission denials and confirmation-like stalls surface
    // instead of hiding inside the JSON-event wall).
    let pending = "";
    const inspectLines = (text) => {
      pending += text;
      let boundary = pending.indexOf("\n");
      while (boundary !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        const notice = line.trim() ? step.inspectLine?.(line) : null;
        if (notice) channel.push({ type: "notice", message: notice });
        boundary = pending.indexOf("\n");
      }
    };
    for await (const chunk of stream) {
      if (truncated) continue;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const slice = buffer.subarray(0, Math.max(0, outputCapBytes - bytes));
      bytes += slice.length;
      if (slice.length > 0) {
        const text = decoder.write(slice);
        if (text) {
          channel.push({ type: "output", stream: name, text });
          if (step.inspectLine) inspectLines(text);
        }
      }
      if (slice.length < buffer.length) {
        truncated = true;
        channel.push({ type: "truncated" });
      }
    }
    const tail = decoder.end();
    if (tail && !truncated) {
      channel.push({ type: "output", stream: name, text: tail });
      if (step.inspectLine) inspectLines(tail);
    }
  };

  void (async () => {
    const spec = runCommands[engine]?.({ pr, issue, model, baseBranch, hostRepoRoot });
    // Single-command engines normalize into a one-step plan named for what it
    // is; a plan-shaped spec rides as-is. A null spec is the engine's own
    // "unavailable" answer (binary resolution failed) — a typed error instead
    // of a doomed run.
    const planShape =
      spec === null || spec === undefined
        ? null
        : spec.steps
          ? spec
          : {
              steps: [
                { name: "review", command: spec.command, args: spec.args, cwd: hostRepoRoot },
              ],
              cleanup: null,
            };

    let failed = null;
    let lastExit = null;

    if (!planShape) {
      channel.push({
        type: "error",
        reason: "engine_unavailable",
        message: `the ${engine} engine did not produce a run — its CLI may be missing`,
      });
    } else {
      for (const step of planShape.steps) {
        if (ended || cancelled) break;
        const child = spawn({
          command: step.command,
          args: step.args,
          cwd: step.cwd,
          env: step.env,
        });
        currentChild = child;
        // The step timeout bounds each step of an unattended plan; a step
        // without its own bound inherits the run's default.
        timeoutTimer = setTimeout(() => {
          if (ended || stopping) return;
          timedOut = true;
          channel.push({
            type: "error",
            reason: "timeout",
            message: `the ${engine} ${step.name} step exceeded ${Math.round(
              (step.timeoutMs ?? timeoutMs) / 1000,
            )}s and was stopped`,
          });
          stopProcess();
        }, step.timeoutMs ?? timeoutMs);

        // A stdio stream failure must not become an unhandled rejection; the
        // child's exit still surfaces through `exited` with its own error.
        void readStream(child.stdout, "stdout", step).catch(() => {});
        void readStream(child.stderr, "stderr", step).catch(() => {});

        const exit = await child.exited;
        clearTimeout(timeoutTimer);
        currentChild = null;
        if (!step.bestEffort) lastExit = exit;

        // A best-effort step expects to fail sometimes (the issue agent's
        // clearing step has nothing to clear on a first run): its failure is
        // not the plan's, and the next step still runs.
        if (step.bestEffort && !cancelled && !timedOut) continue;

        if (exit.error) {
          failed = {
            reason: "spawn_failed",
            message: String(exit.error?.message ?? exit.error),
          };
          channel.push({ type: "error", ...failed });
          break;
        }
        if (cancelled || timedOut) break;
        if (exit.code !== 0) {
          // A one-step plan is a review command: its non-zero exit is the
          // exit event's own verdict, exactly as it always was. An orchestrated
          // plan names the step that failed and stops before the next one.
          if (planShape.steps.length > 1) {
            failed = {
              reason: "step_failed",
              message: `the ${engine} ${step.name} step failed with exit code ${exit.code}`,
            };
            channel.push({ type: "error", ...failed });
          }
          break;
        }
      }
    }

    ended = true;
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    // The plan's cleanup always runs, best-effort, before the exit is
    // announced; what "ok" means — remove the worktree, keep the evidence —
    // is the plan's own decision (issue #40: failed runs keep theirs).
    try {
      planShape?.cleanup?.({
        ok: !failed && !cancelled && !timedOut && (lastExit?.code ?? 1) === 0,
      });
    } catch {
      // best-effort: a cleanup failure never breaks the run's ending
    }
    channel.push({
      type: "exit",
      // A stop the run itself performed (cancel, timeout, spawn failure) has
      // no meaningful exit code; a step's own non-zero exit passes through —
      // the error event, when one precedes it, carries the reason.
      code: cancelled || timedOut ? null : (lastExit?.code ?? null),
      signal: lastExit?.signal ?? null,
      cancelled,
    });
    channel.close();
  })();

  return {
    engine,
    events: channel.stream(),
    cancel,
  };
};

// The endpoint's in-memory registry (ticket #26): one active run per engine,
// so a second start attempt is a typed busy rejection, never a silent queue.
// A start claims the engine first — before any spawning — and binds its run
// once one exists; the claim is released if resolution or spawn fails, and
// by the run's stream when it ends.
export const createRunRegistry = () => {
  // A claimed-but-unbound engine holds a reservation: the run does not exist
  // yet, but a cancel that arrives in that window is remembered and applied
  // at bind time instead of being dropped.
  const RESERVATION = () => ({ __reservation: true, cancelRequested: false });
  const isRun = (entry) => entry !== null && entry !== undefined && !entry.__reservation;
  const active = new Map();
  return {
    claim(engine) {
      if (active.has(engine)) return false;
      active.set(engine, RESERVATION());
      return true;
    },
    bind(engine, run) {
      const entry = active.get(engine);
      if (entry && !isRun(entry) && entry.cancelRequested) run.cancel();
      active.set(engine, run);
    },
    release(engine) {
      active.delete(engine);
    },
    active(engine) {
      const entry = active.get(engine);
      return isRun(entry) ? entry : null;
    },
    // A cancel for a bound run stops it; for a reservation it is applied the
    // moment the run binds.
    cancel(engine) {
      const entry = active.get(engine);
      if (entry === undefined || entry === null) return false;
      if (isRun(entry)) entry.cancel();
      else entry.cancelRequested = true;
      return true;
    },
    // The dev server shutting down is the last chance to stop the detached
    // process groups it spawned; reservations remember it for their bind.
    cancelAll() {
      for (const entry of active.values()) {
        if (isRun(entry)) entry.cancel();
        else entry.cancelRequested = true;
      }
    },
  };
};
