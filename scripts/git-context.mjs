// The one env sanitizer for git subprocesses and fixture git calls. A git
// command that runs under a caller's git context — a pre-commit hook exports
// GIT_DIR, GIT_WORK_TREE, and GIT_INDEX_FILE to everything it spawns, this
// suite and the package prepare step included — silently targets the
// caller's repository instead of the directory it was handed, or deadlocks
// waiting on it. Everything spawning git from a script or test strips that
// context first; anything else the environment carries still travels.
export const envWithoutGitContext = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
};
