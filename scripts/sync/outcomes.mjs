// Outcomes (ticket #16): the Developer's own pull requests on the host
// repo over a rolling 30 days — opened, merged, and median time-to-merge
// — folded into the Telemetry payload. GitHub remotes only in v1; a
// non-GitHub remote reports no Outcomes and the payload still sends.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

const execFileAsync = promisify(execFile);

export function isGitHubRemote(repositoryUrl) {
  try {
    // scp-style remotes (git@github.com:acme/widgets.git) carry the host
    // before the colon rather than in a URL hostname.
    const scp = /^(?:ssh:\/\/)?git@([^:/]+)[:/]/.exec(repositoryUrl);
    if (scp) return GITHUB_HOSTS.has(scp[1]);
    return GITHUB_HOSTS.has(new URL(repositoryUrl).hostname);
  } catch {
    return false;
  }
}

// Same auth fallback as the issues adapter: the token environment
// variable first, then an authenticated gh CLI.
async function resolveToken(env) {
  const fromEnv = typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "";
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

// A non-GitHub remote yields undefined: the field is omitted from the
// payload rather than zero-filled.
export async function outcomesForRepository({ repositoryUrl, login, env, fetchImpl }) {
  if (!isGitHubRemote(repositoryUrl) || !login) return undefined;
  try {
    return await fetchOutcomes({ repositoryUrl, login, env, fetchImpl });
  } catch {
    // Outcomes are enrichment: an adapter failure omits the field instead
    // of failing the payload.
    return undefined;
  }
}

export async function fetchOutcomes({
  repositoryUrl,
  login,
  token,
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  resolveTokenImpl = resolveToken,
}) {
  const { pathname } = new URL(repositoryUrl);
  const [, owner, repo] = pathname.replace(/\.git$/, "").split("/");
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`;
  const resolved = token ?? (await resolveTokenImpl(env));
  const response = await fetchImpl(url, {
    headers: {
      ...(resolved ? { Authorization: `Bearer ${resolved}` } : {}),
      accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

  const pulls = await response.json();
  const mine = pulls.filter((pull) => pull.user?.login === login && pull.created_at >= since);
  const mergedDurations = mine
    .filter((pull) => pull.merged_at)
    .map((pull) => Date.parse(pull.merged_at) - Date.parse(pull.created_at))
    .sort((left, right) => left - right);

  let median = null;
  if (mergedDurations.length > 0) {
    const middle = Math.floor(mergedDurations.length / 2);
    median =
      mergedDurations.length % 2 === 1
        ? mergedDurations[middle]
        : (mergedDurations[middle - 1] + mergedDurations[middle]) / 2;
  }
  return { opened: mine.length, merged: mergedDurations.length, medianTimeToMergeMs: median };
}
