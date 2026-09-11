import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { deriveWorkItem } from "./labels.mjs";

const execFileAsync = promisify(execFile);

// `gh issue view --json` reports the GraphQL state spelling (OPEN/CLOSED) and
// names the web url `url`; the tracker grammar expects the REST shapes. Both
// seam surfaces that read an issue back share this normalization, so the
// served state stays tracker-derived rather than drifting from it.
export const issueFromGhView = (payload) => ({
  number: payload.number,
  title: payload.title ?? "",
  body: payload.body ?? "",
  state: String(payload.state ?? "").toLocaleLowerCase() === "closed" ? "closed" : "open",
  html_url: payload.url ?? "",
  assignees: Array.isArray(payload.assignees) ? payload.assignees : [],
  labels: Array.isArray(payload.labels) ? payload.labels : [],
});

// gh saying the issue (or PR) does not exist is an answer; every other
// failure — auth, network, rate limit — must not masquerade as "unknown".
export const isGhNotFound = (error) =>
  /could not resolve|not found|no pull request/i.test(
    String(error?.stderr ?? error?.message ?? error),
  );

// One issue read through the same gh a Developer would run by hand (ADR
// 0005), derived through the same label grammar sync uses. The `run` seam
// mirrors the workflow API's command runner; the default shells out.
export const ghIssueRecord = async ({ issue, repo, cwd, run } = {}) => {
  const execute = run ?? ((args) => execFileAsync("gh", args, { cwd, encoding: "utf8" }));
  const readBack = await execute([
    "issue",
    "view",
    String(issue),
    "--repo",
    repo,
    "--json",
    "number,title,url,state,assignees,labels,body",
  ]);
  return deriveWorkItem(issueFromGhView(JSON.parse(readBack.stdout))).record;
};
