import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

// The review runner seam (epic #20): the one component that knows how to
// execute a review and probe the review engines' health. This is the seam's
// health half (ticket #24): per-engine availability — CLI binary found (with
// its version), authentication / provider status — as typed states with a
// one-step remediation message. Probes only ever invoke version and auth
// subcommands, never a review, and are safe to call repeatedly. The child-
// process spawn function is injected so tests substitute a fake CLI binary;
// the endpoint and the UI are thin layers over this module.

// The spawn contract: `spawn({ command, args })` runs the CLI and returns
// `{ status, stdout, stderr, error? }` — spawnSync's natural shape.
const nodeSpawn = ({ command, args }) =>
  spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });

export const REVIEW_ENGINES = ["coderabbit", "zcode"];

// Runs `<binary> --version` and classifies the outcome: the binary is either
// found (with its version string), missing (ENOENT), or present but broken.
const versionProbe = ({ spawn, binary }) => {
  const result = spawn({ command: binary, args: ["--version"] });
  if (result.error?.code === "ENOENT") return { kind: "binary_missing" };
  if (result.status !== 0)
    return {
      kind: "probe_error",
      message: result.stderr.trim() || `${binary} --version exited with status ${result.status}`,
    };
  return { kind: "found", version: result.stdout.trim() };
};

const coderabbitEngine = {
  name: "coderabbit",
  // Docs: docs.coderabbit.ai/cli — `coderabbit auth status` checks the
  // stored Agentic API key without touching the network side of a review.
  probeHealth({ spawn }) {
    const probe = versionProbe({ spawn, binary: "coderabbit" });
    if (probe.kind === "binary_missing")
      return {
        engine: "coderabbit",
        state: "binary_missing",
        remediation: "install the CodeRabbit CLI: brew install coderabbit",
      };
    if (probe.kind === "probe_error")
      return { engine: "coderabbit", state: "probe_error", message: probe.message };
    const auth = spawn({ command: "coderabbit", args: ["auth", "status"] });
    if (auth.status !== 0)
      return {
        engine: "coderabbit",
        state: "auth_missing",
        version: probe.version,
        remediation:
          "run `coderabbit auth login --api-key <your Agentic API key>` — headless reviews need the Agentic key",
      };
    return { engine: "coderabbit", state: "ready", version: probe.version };
  },
};

export const engines = [
  coderabbitEngine,
  {
    name: "zcode",
    // Docs: the zcode headless failure mode is `Model config is missing. Create
    // ~/.zcode/cli/config.json with an explicit model provider` — the config
    // file's presence is the provider check, and `zcode login` writes it.
    probeHealth({ spawn, homedir = osHomedir }) {
      const probe = versionProbe({ spawn, binary: "zcode" });
      if (probe.kind === "binary_missing")
        return {
          engine: "zcode",
          state: "binary_missing",
          remediation: "install the ZCode desktop app — the zcode CLI ships inside it",
        };
      if (probe.kind === "probe_error")
        return { engine: "zcode", state: "probe_error", message: probe.message };
      const configured = existsSync(join(homedir(), ".zcode", "cli", "config.json"));
      if (!configured)
        return {
          engine: "zcode",
          state: "provider_missing",
          version: probe.version,
          remediation: "run `zcode login` to configure a model provider",
        };
      return { engine: "zcode", state: "ready", version: probe.version };
    },
  },
];

export const reviewHealth = ({ spawn = nodeSpawn, homedir = osHomedir } = {}) => ({
  engines: engines.map((engine) => engine.probeHealth({ spawn, homedir })),
});
