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
// CI-only (`pnpm test:pack`): it needs registry access and a few minutes, so
// the per-commit gate (`pnpm test`) deliberately does not run it.
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
