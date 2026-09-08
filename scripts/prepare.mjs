// The package `prepare` script points `core.hooksPath` at `.githooks/` so the
// local CI gate runs on every commit. The git probe keeps installs succeeding
// outside git checkouts (source zips, packaged copies), where the hook could
// not run anyway; linked worktrees have `.git` as a file, so the probe goes
// through git itself rather than the filesystem.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ensureHooksPath = ({ directory, hooksPath = ".githooks" }) => {
  const options = { cwd: directory, stdio: "ignore" };
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], options);
  } catch {
    return { enabled: false };
  }
  execFileSync("git", ["config", "core.hooksPath", hooksPath], options);
  return { enabled: true };
};

const main = () => {
  const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { enabled } = ensureHooksPath({ directory: appDirectory });
  if (!enabled) console.log("[workbench] not a git checkout; skipping git hooks setup");
};

// Guard so importing this module (prepare.test.mjs) does not touch git config.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
