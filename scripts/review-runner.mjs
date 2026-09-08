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
// `{ status, stdout, stderr, error? }` — spawnSync's natural shape. The
// timeout keeps a hung CLI from stalling the dev server's event loop; the
// version/auth subcommands answer in milliseconds.
const nodeSpawn = ({ command, args }) =>
  spawnSync(command, args, { encoding: "utf8", timeout: 5_000 });

// Classifies a version probe: the binary is either found (with its version
// string), missing (ENOENT — also when it vanishes between probes), or
// present but failing (a CLI exit carries stderr; a spawn-level failure
// carries the spawn error's own message).
const versionProbe = ({ spawn, binary }) => {
  const result = spawn({ command: binary, args: ["--version"] });
  if (result.error?.code === "ENOENT") return { kind: "binary_missing" };
  if (result.status !== 0)
    return {
      kind: "probe_error",
      message:
        result.stderr.trim() ||
        result.error?.message ||
        `${binary} --version exited with status ${result.status}`,
    };
  return { kind: "found", version: result.stdout.trim() };
};

const binaryMissing = (engine, remediation) => ({ engine, state: "binary_missing", remediation });
const probeError = (engine, message) => ({ engine, state: "probe_error", message });

const coderabbitEngine = {
  name: "coderabbit",
  // Docs: docs.coderabbit.ai/cli — `coderabbit auth status` checks the
  // stored Agentic API key without touching the network side of a review.
  probeHealth({ spawn }) {
    const probe = versionProbe({ spawn, binary: "coderabbit" });
    if (probe.kind === "binary_missing")
      return binaryMissing("coderabbit", "install the CodeRabbit CLI: brew install coderabbit");
    if (probe.kind === "probe_error") return probeError("coderabbit", probe.message);
    const auth = spawn({ command: "coderabbit", args: ["auth", "status"] });
    if (auth.error?.code === "ENOENT")
      return binaryMissing("coderabbit", "install the CodeRabbit CLI: brew install coderabbit");
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

const engines = [coderabbitEngine, zcodeEngine];

export const reviewHealth = ({ spawn = nodeSpawn, homedir = osHomedir } = {}) => ({
  engines: engines.map((engine) => engine.probeHealth({ spawn, homedir })),
});
