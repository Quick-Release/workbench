// Ticket #113: the shipped CLI must start without Workbench's devDependencies
// and without worker/ test resources. Source checkouts can never police that
// boundary — their node_modules always carry the dev dependencies and their
// tree always has worker/ — so this smoke packs the real tarball, installs it
// into a fresh fixture host repo, and boots the installed package's dev
// server offline (stubbed `gh`, no tokens, no telemetry), asserting the
// dashboard and one read-only API endpoint answer.
//
// CI-only (`pnpm test:pack`): it needs registry access and a few minutes, so
// the per-commit gate (`pnpm test`) deliberately does not run it.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as netCreateServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "../..");

const BOOT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;
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

const freePort = () =>
  new Promise((resolvePort, rejectPort) => {
    const server = netCreateServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

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

// The offline env shared by the fixture sync and the boot: fixture source
// root, no service tokens, stubbed gh first on PATH, and CI=1 so the
// package's prepare script never points the fixture repo's git hooks at the
// install.
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

// Stub for the sync step bin.mjs runs before the dev server: the dashboard's
// src/data.generated.ts is generated, never shipped, and the installed sync
// cannot run (its scripts import src/lib/*.ts, which Node refuses to
// type-strip under node_modules — the separate defect this smoke isolates).
// So generate the module with the checkout's generator against the fixture
// host repo — the same output sync would produce — and place it into the
// installed package.
const stubSyncInInstalledPackage = async ({ hostDir, installedDirectory, parentEnv }) => {
  run(process.execPath, [join(appDirectory, "scripts/commands/sync-data.mjs")], {
    cwd: appDirectory,
    env: await offlineEnv({ hostDir, parentEnv }),
  });
  await copyFile(
    join(appDirectory, "src/data.generated.ts"),
    join(installedDirectory, "src/data.generated.ts"),
  );
};

// Boots the installed CLI and polls until both the dashboard and one
// read-only API endpoint answer 200. Returns a captured output tail for
// failure messages; throws (with that tail) on early exit, wrong status, or
// deadline. Startup failures surface here because the CLI's config-loading
// path is exactly what ticket #113 protects.
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exitedEarly = await Promise.race([
      exited.then(() => true),
      delay(POLL_INTERVAL_MS).then(() => false),
    ]);
    if (exitedEarly) throw new Error(`installed CLI exited before serving:\n${tail()}`);
    try {
      for (const path of ["/", "/api/skills"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        if (response.status !== 200)
          throw new Error(`${path} answered ${response.status}, expected 200:\n${tail()}`);
      }
    } catch (cause) {
      if (cause.message.includes("expected 200")) throw cause;
      continue; // not serving yet — keep polling until the deadline
    }
    return tail;
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
    await stubSyncInInstalledPackage({
      hostDir,
      installedDirectory,
      parentEnv: process.env,
    });
    console.log("[pack-smoke] stubbed the sync step with fixture data");

    const port = await freePort();
    // This ticket's boundary is the Vite config-loading path, so the smoke
    // boots the installed package the way bin.mjs does — `vp dev` from the
    // package directory against the fixture source root — but resolves the
    // binary itself and skips bin.mjs's sync step. Sync is isolated per the
    // ticket's own instruction ("isolate/stub sync … so any earlier startup
    // problem does not hide it"): scripts/tracker imports src/lib/*.ts, and
    // Node refuses to type-strip files under node_modules, so the installed
    // sync currently fails before dev for reasons outside this ticket. When
    // that defect is fixed, switch back to spawning bin.mjs for an
    // end-to-end boot.
    const require = createRequire(join(installedDirectory, "package.json"));
    const vitePlusDirectory = dirname(require.resolve("vite-plus/package.json"));
    const { bin } = JSON.parse(readFileSync(join(vitePlusDirectory, "package.json"), "utf8"));
    const vp = join(vitePlusDirectory, typeof bin === "string" ? bin : bin.vp);
    // --host pins the loopback interface: a bare `localhost` bind resolves
    // IPv6-first on CI runners, and the probe below speaks IPv4.
    child = spawn(vp, ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: installedDirectory,
      env: await bootEnv({ hostDir, port }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    await awaitServing(child, port, BOOT_TIMEOUT_MS);
    console.log("[pack-smoke] installed dev server serves / and /api/skills with 200");
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
