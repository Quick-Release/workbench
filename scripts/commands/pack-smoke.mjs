// Ticket #113/#195: the shipped CLI must start in a clean host repository —
// no Workbench devDependencies, no worker/ test resources, and a sync that
// runs under raw Node from node_modules. Source checkouts can never police
// that boundary — their node_modules always carry the dev dependencies and
// their tree always has worker/ and generated data — so this smoke packs the
// real tarball, installs it into a fresh fixture host repo, and boots the
// installed CLI's full bin.mjs pipeline (sync → fmt → dev server) offline
// (stubbed `gh`, no tokens, no telemetry), asserting the dashboard and one
// read-only API endpoint answer.
//
// Ticket #240 extends the same smoke, it does not duplicate it: the tarball
// must carry the owned-clarification capability, and the installed boot must
// expose it per its posture — the capability answering its typed dormant and
// denial readiness states offline, with the shapes the unit tier
// (scripts/seam/routes/clarification-api.test.mjs) holds the seam to.
//
// CI-only (`pnpm test:pack`): it needs registry access and a few minutes, so
// the per-commit gate (`pnpm test`) deliberately does not run it.
import { deepStrictEqual } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as netCreateServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "../..");

const BOOT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;
// Workers test resources must never ride in the artifact: worker/ is the
// runtime test source tree, and vite.worker.config.ts is the test-only
// config that imports the dev-only plugin. The shipped vite config must not
// reference either (ticket #113).
const FORBIDDEN_ENTRY_PATTERNS = [/^package\/worker\//, /vite\.worker\.config/];
const FORBIDDEN_CONFIG_REFERENCES = ["@cloudflare/vitest-pool-workers", "worker/migrations"];

export const forbiddenTarballEntries = (entries) =>
  entries.filter((entry) => FORBIDDEN_ENTRY_PATTERNS.some((pattern) => pattern.test(entry)));

export const shippedConfigViolations = (configText) =>
  FORBIDDEN_CONFIG_REFERENCES.filter((reference) => configText.includes(reference));

// The capability ships dark but it must ship (spec #221, ADR 0013): every
// module the installed boot's clarification seam is built from, present in
// the artifact. The tarball-cleanliness guards above stay exactly as they
// are — this is a positive assertion, never a second forbidden list.
const CAPABILITY_ENTRIES = [
  "package/scripts/seam/routes/clarification-api.mjs",
  "package/scripts/seam/clarification/posture.mjs",
  "package/scripts/seam/clarification/context-packet.mjs",
  "package/scripts/seam/clarification/coordinator.mjs",
  "package/scripts/seam/clarification/pi-managed.mjs",
  "package/scripts/seam/clarification/store.mjs",
  "package/scripts/host/config.mjs",
  "package/src/schema.ts",
];

export const missingCapabilityEntries = (entries) => {
  const present = new Set(entries);
  return CAPABILITY_ENTRIES.filter((entry) => !present.has(entry));
};

// The installed boot's clarification answers, held to the exact shapes the
// unit tier holds the seam to — restated here as literals on purpose: the
// package tier's job is to catch an installed artifact answering anything
// else, so it must not import the seam it is judging. The probes run
// offline against the fixture host, where the capability has no config
// block: its readiness is the typed dormant posture, and its start route
// answers the typed policy denial, whatever the body carried. Writing an
// incomplete clarification block into the fixture host moves the same boot
// to the invalid posture — the posture resolves per request — and the
// denial then names the offending elements.
const INVALID_POSTURE_REASONS = [
  "clarification.provider is required when clarification is enabled",
  "clarification.dataDestination is required when clarification is enabled",
];

const matches = (actual, expected) => {
  try {
    deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
};

export const clarificationContractFailures = (phase, { status, json }) => {
  const failures = [];
  const named = (failure) => failures.push(`${phase}: ${failure}`);

  if (json === undefined) return [`${phase}: response body was not JSON`];

  switch (phase) {
    case "dormant-status":
    case "restored-status": {
      if (status !== 200) named(`status must be 200, got ${status}`);
      if (json?.posture !== "disabled")
        named(`posture must be "disabled", got ${JSON.stringify(json?.posture)}`);
      if (json?.available !== false)
        named(`available must be false, got ${JSON.stringify(json?.available)}`);
      if (json?.reasons !== undefined)
        named(`must carry no reasons, got ${JSON.stringify(json?.reasons)}`);
      if (json?.message !== undefined)
        named(`must carry no message, got ${JSON.stringify(json?.message)}`);
      break;
    }
    case "dormant-start": {
      if (status !== 403) named(`status must be 403, got ${status}`);
      if (json?.error !== "clarification_disabled")
        named(`error must be "clarification_disabled", got ${JSON.stringify(json?.error)}`);
      if (!/not enabled/.test(String(json?.message)))
        named(`message must name the disabled posture, got ${JSON.stringify(json?.message)}`);
      break;
    }
    case "invalid-status": {
      if (status !== 200) named(`status must be 200, got ${status}`);
      if (json?.posture !== "invalid")
        named(`posture must be "invalid", got ${JSON.stringify(json?.posture)}`);
      if (json?.available !== false)
        named(`available must be false, got ${JSON.stringify(json?.available)}`);
      if (!matches(json?.reasons, INVALID_POSTURE_REASONS))
        named(
          `posture reasons must be the two missing-element reasons, got ${JSON.stringify(json?.reasons)}`,
        );
      if (json?.message !== undefined)
        named(`must carry no message, got ${JSON.stringify(json?.message)}`);
      break;
    }
    case "invalid-start": {
      if (status !== 403) named(`status must be 403, got ${status}`);
      if (json?.error !== "clarification_posture_invalid")
        named(`error must be "clarification_posture_invalid", got ${JSON.stringify(json?.error)}`);
      if (!matches(json?.reasons, INVALID_POSTURE_REASONS))
        named(
          `denial reasons must be the two missing-element reasons, got ${JSON.stringify(json?.reasons)}`,
        );
      if (!/clarification\.provider is required/.test(String(json?.message)))
        named(`message must name the offending elements, got ${JSON.stringify(json?.message)}`);
      break;
    }
    default:
      return [`${phase}: unknown probe phase`];
  }
  return failures;
};

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

// A port outside the OS ephemeral range: this smoke's own npm install and
// the dev server's dependency fetches fill the ephemeral range with outbound
// connections, and a vite dev server bound into that range has been observed
// to drop its listener at the post-optimizer reload (GH-195 follow-up).
// Bind-test candidates on loopback and hand back the first free one.
const freePort = async () => {
  for (let candidate = 40600 + Math.floor(Math.random() * 300); candidate < 40999; candidate += 1) {
    const free = await new Promise((resolvePort) => {
      const server = netCreateServer();
      server.unref();
      server.once("error", () => resolvePort(false));
      server.listen(candidate, "127.0.0.1", () => server.close(() => resolvePort(true)));
    });
    if (free) return candidate;
  }
  throw new Error("no free port found in the 40600-40999 range");
};

const run = (name, args, options = {}) =>
  execFileSync(name, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

// Packs the checkout into `destination` and returns the tarball path.
const packTarball = async (destination) => {
  run("pnpm", ["pack", "--pack-destination", destination], { cwd: appDirectory });
  const tarball = (await readdir(destination)).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) throw new Error(`pnpm pack produced no tarball in ${destination}`);
  return join(destination, tarball);
};

// The shipped-config guard reads the copy inside the artifact, not the
// checkout's — what ships is what must be clean.
const tarballConfigText = (tarballPath) =>
  run("tar", ["-xzf", tarballPath, "-O", "package/vite.config.ts"]);

const assertTarballIsClean = (tarballPath) => {
  const forbiddenEntries = forbiddenTarballEntries(run("tar", ["-tzf", tarballPath]).split("\n"));
  if (forbiddenEntries.length > 0)
    throw new Error(`tarball ships test-only files: ${forbiddenEntries.join(", ")}`);
  const violations = shippedConfigViolations(tarballConfigText(tarballPath));
  if (violations.length > 0)
    throw new Error(
      `shipped vite.config.ts references dev-only resources: ${violations.join(", ")}`,
    );
};

// The positive counterpart to the cleanliness guard: the artifact must not
// merely be clean of test resources — it must carry the clarification
// capability it claims to ship dark (ticket #240).
const assertTarballCarriesCapability = (tarballPath) => {
  const missing = missingCapabilityEntries(run("tar", ["-tzf", tarballPath]).split("\n"));
  if (missing.length > 0)
    throw new Error(`tarball is missing the clarification capability: ${missing.join(", ")}`);
};

// Fixture host repo: a real git checkout with one commit and no remote, so
// tracker collection skips (no owner/name, no token) instead of calling out.
const seedHostRepo = async (hostDir) => {
  await writeFile(join(hostDir, "README.md"), "# pack-smoke fixture\n");
  run("git", ["init", "-q"], { cwd: hostDir });
  run("git", ["-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "add", "README.md"], {
    cwd: hostDir,
  });
  run(
    "git",
    [
      "-c",
      "user.email=smoke@example.com",
      "-c",
      "user.name=smoke",
      "commit",
      "-q",
      "-m",
      "fixture: seed the pack-smoke host repo",
    ],
    { cwd: hostDir },
  );
};

// A `gh` that always fails keeps the tracker credential chain offline no
// matter how the machine running the smoke is authenticated.
const seedGhStub = async (stubDir) => {
  await mkdir(stubDir, { recursive: true });
  const stub = join(stubDir, "gh");
  await writeFile(stub, "#!/bin/sh\nexit 1\n");
  await chmod(stub, 0o700);
};

// The env the installed CLI boots under: fixture source root, no service
// tokens, stubbed gh first on PATH, and CI=1 so the package's prepare script
// never points the fixture repo's git hooks at the install.
const offlineEnv = async ({ hostDir, parentEnv = process.env }) => {
  const env = { ...parentEnv };
  for (const key of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_API_TOKEN",
    "TELEMETRY_INGEST_URL",
    "TELEMETRY_INGEST_TOKEN",
    "WORKBENCH_DEMO_SOURCE",
  ])
    delete env[key];
  env.CI = "1";
  env.WORKBENCH_SOURCE_ROOT = hostDir;
  await seedGhStub(join(hostDir, ".smoke-stub"));
  env.PATH = `${join(hostDir, ".smoke-stub")}:${env.PATH ?? ""}`;
  return env;
};

const bootEnv = async ({ hostDir, port, parentEnv }) => ({
  ...(await offlineEnv({ hostDir, parentEnv })),
  WORKBENCH_PORT: String(port),
});

// Boots the installed CLI and polls until both the dashboard and one
// read-only API endpoint answer 200. Returns a captured output tail for
// failure messages; throws (with that tail) on early exit or deadline.
// Startup failures surface here because the CLI's startup path is exactly
// what tickets #113/#195 protect.
const awaitServing = async (child, port, timeoutMs) => {
  const output = [];
  const capture = (chunk) => {
    output.push(chunk);
    if (output.length > 400) output.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const tail = () => output.join("").slice(-4000);
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  // One request at a time, each hard-bounded: a cold-start request can hang
  // (Vite's dependency optimizer accepts the connection, then reloads the
  // server mid-flight), and an unbounded fetch would stall this loop past
  // the deadline. bin.mjs passes no --host, so which loopback stack `localhost`
  // binds first differs by platform (IPv6-first on CI runners); serving is
  // confirmed when ANY one spelling answers 200 for both paths — never a
  // conjunction across spellings, which can never all bind at once.
  const serving = async () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      let served = true;
      for (const path of ["/", "/api/skills"]) {
        try {
          const response = await fetch(`http://${host}:${port}${path}`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          // Drain the body — undici keeps the socket pooled until it is
          // consumed, and an undrained probe would leak one per poll round.
          await response.body?.cancel()?.catch(() => {});
          if (response.status !== 200) served = false;
        } catch {
          served = false; // refused or hung — not the bound stack (or not ready yet)
        }
        if (!served) break;
      }
      if (served) return;
    }
    throw new Error(`no loopback spelling served / and /api/skills yet:\n${tail()}`);
  };
  // Two consecutive clean passes: the first can complete just before the
  // optimizer's "dependencies changed, reloading" restart drops it.
  let consecutivePasses = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exitedEarly = await Promise.race([
      exited.then(() => true),
      delay(POLL_INTERVAL_MS).then(() => false),
    ]);
    if (exitedEarly) throw new Error(`installed CLI exited before serving:\n${tail()}`);
    try {
      await serving();
      consecutivePasses += 1;
    } catch {
      consecutivePasses = 0;
      continue; // not serving yet — keep polling until the deadline
    }
    if (consecutivePasses >= 2) return tail;
    await delay(1_000);
  }
  throw new Error(`installed CLI did not serve within ${timeoutMs}ms:\n${tail()}`);
};

const stopTree = async (child) => {
  if (!child?.pid) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const gone = await Promise.race([exited.then(() => true), delay(2_000).then(() => false)]);
  if (!gone) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
};

// One clarification probe against the installed boot. Which loopback
// spelling bound is the platform's call (see awaitServing), so the probe
// tries the spellings and takes the first that answers — an answered
// response is returned whatever its status, because a contract drift is
// exactly what the probe must catch. Only transport errors retry, so a
// real drift fails the smoke instead of wearing the deadline down.
const probeClarification = async (port, path, init, attempts = 3) => {
  let lastError;
  for (let attempt = 1; ; attempt += 1) {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      try {
        const response = await fetch(`http://${host}:${port}${path}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...init,
        });
        const text = await response.text();
        return { status: response.status, text };
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt >= attempts) throw lastError ?? new Error("no loopback spelling answered");
    await delay(1_000);
  }
};

// The offline readiness walk (ticket #240). The fixture host has no
// workbench.config.json, so the installed capability's readiness is the
// typed dormant posture and its start route the typed policy denial;
// writing an incomplete clarification block moves the same boot — the
// posture resolves per request — to the invalid posture, whose denial
// names the offending elements; removing it restores the dormant state.
// Every answer is held to the unit-tier contract before the smoke passes.
const probeClarificationReadiness = async ({ child, port, hostDir }) => {
  const output = [];
  const capture = (chunk) => {
    output.push(chunk);
    if (output.length > 400) output.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const tail = () => output.join("").slice(-4000);
  const configPath = join(hostDir, "workbench.config.json");
  const expect = async (phase, path, init) => {
    const probe = await probeClarification(port, path, init);
    let json;
    try {
      json = JSON.parse(probe.text);
    } catch {
      json = undefined;
    }
    const failures = clarificationContractFailures(phase, { status: probe.status, json });
    if (failures.length > 0)
      throw new Error(
        `installed clarification boot drifted from the unit-tier contract:\n  ${failures.join(
          "\n  ",
        )}\n${tail()}`,
      );
    console.log(`[pack-smoke] ${phase} matches the unit-tier contract`);
  };

  await expect("dormant-status", "/api/clarification");
  await expect("dormant-start", "/api/clarification/start", { method: "POST", body: "{}" });
  await writeFile(configPath, `${JSON.stringify({ clarification: { enabled: true } }, null, 2)}\n`);
  await expect("invalid-status", "/api/clarification");
  await expect("invalid-start", "/api/clarification/start", { method: "POST", body: "{}" });
  await rm(configPath, { force: true });
  await expect("restored-status", "/api/clarification");
};

const main = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "workbench-pack-smoke-"));
  const destination = join(workspace, "pack");
  const hostDir = join(workspace, "host-repo");
  await mkdir(destination, { recursive: true });
  await mkdir(hostDir, { recursive: true });
  let child;
  try {
    const tarballPath = await packTarball(destination);
    assertTarballIsClean(tarballPath);
    assertTarballCarriesCapability(tarballPath);
    console.log(`[pack-smoke] packed ${tarballPath}`);

    await seedHostRepo(hostDir);
    const installedDirectory = join(hostDir, "node_modules", "@quick-release", "workbench");
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarballPath], {
      cwd: hostDir,
    });
    console.log("[pack-smoke] installed the tarball into a fresh host repo");

    const port = await freePort();
    // The full installed pipeline: bin.mjs runs the sync (raw Node, from
    // node_modules — the exact graph GH-195 made importable), formats the
    // generated snapshot, and starts the dev server against the fixture
    // source root.
    const installedBin = join(hostDir, "node_modules", "@quick-release", "workbench", "bin.mjs");
    child = spawn(process.execPath, [installedBin], {
      cwd: hostDir,
      env: await bootEnv({ hostDir, port }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await awaitServing(child, port, BOOT_TIMEOUT_MS);
    console.log("[pack-smoke] installed CLI serves / and /api/skills with 200");

    // Still offline: the same stubbed gh, no tokens, no telemetry as the
    // boot — the capability must answer its readiness states without any
    // of it (ticket #240).
    await probeClarificationReadiness({ child, port, hostDir });
  } finally {
    await stopTree(child);
    await rm(workspace, { recursive: true, force: true });
  }
};

// Guard so importing this module (pack-smoke.test.mjs) does not pack anything.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
  console.log("[pack-smoke] OK");
}
