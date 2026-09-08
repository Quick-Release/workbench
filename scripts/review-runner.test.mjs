import { deepStrictEqual, match, strictEqual } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reviewHealth } from "./review-runner.mjs";

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
  strictEqual(
    calls.some((argv) => argv.includes("review")),
    false,
    "health never runs a review",
  );
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
  // opaque misdirection this ticket exists to prevent.
  const { spawn } = cli({
    coderabbit: (arg) =>
      arg === "--version"
        ? { status: 0, stdout: "coderabbit 1.2.3\n", stderr: "" }
        : {
            status: null,
            stdout: "",
            stderr: "",
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
