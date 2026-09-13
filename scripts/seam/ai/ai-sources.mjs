import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The two data sources the draft prompt is assembled from, both read the way
// a Developer would by hand (ADR 0005): the pull request through the `gh`
// CLI, and the style reference from the host repo's local git history. The
// command runner is injected so tests never shell out.

export const ghPullRequestLoader =
  ({ run = execFileAsync } = {}) =>
  async (number) => {
    const { stdout } = await run("gh", [
      "pr",
      "view",
      String(number),
      "--json",
      "number,title,headRefName,baseRefName,author,isDraft,body",
    ]);
    return pullRequestFromGh(JSON.parse(stdout));
  };

export const pullRequestFromGh = (json) => ({
  number: json.number,
  title: json.title,
  head: json.headRefName,
  base: json.baseRefName,
  author: json.author?.login ?? "",
  isDraft: Boolean(json.isDraft),
  body: json.body ?? "",
});

const MAX_COMMIT_SUBJECTS = 20;

export const gitCommitSubjectLister =
  ({ cwd, run = execFileAsync } = {}) =>
  async () => {
    try {
      const { stdout } = await run(
        "git",
        ["log", `--format=%s`, `-n`, String(MAX_COMMIT_SUBJECTS)],
        {
          cwd,
        },
      );
      return parseCommitSubjects(stdout);
    } catch {
      // A style reference is best-effort: a repo without readable history
      // still gets a draft, just without the style section.
      return [];
    }
  };

export const parseCommitSubjects = (stdout) =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
