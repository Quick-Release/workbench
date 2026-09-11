import { httpUrl, requestJson } from "../services/shared.mjs";

// The tracker adapter's read layer: the targeted GitHub REST reads ADR 0008
// prescribes. Distinct from the generic issue-list service adapters, which it
// never shares records with. All list reads paginate under a page cap and
// report truncation instead of silently stopping.
export const PER_PAGE = 100;
export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

const issuesUrl = (apiBase, repo, path = "", params = {}) => {
  const url = new URL(`${apiBase}/repos/${repo}/issues${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
};

const githubHeaders = (token) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": API_VERSION,
  Authorization: `Bearer ${token}`,
});

// The standard tracker REST headers, shared with the other read layers
// (pull requests) so the API version stays pinned in one place.
export { githubHeaders };

const isIssue = (entry) =>
  entry && typeof entry === "object" && typeof entry.number === "number" && !entry.pull_request;

// Shared paged walk for issue-list reads: stops when a short page arrives or
// the cap is reached, and reports which. Continuation counts the *raw* page —
// the issue-list endpoint mixes pull requests into its responses, so the
// filtered issue count on a full page would stop the walk early (GH-136).
// Never throws on a failed page — a failed page degrades to what was
// collected plus a warning, and reports itself through `failed`.
const pagedIssues = async ({ fetchImpl, token, urlFor, maxPages, what }) => {
  const issues = [];
  const warnings = [];
  let capped = false;
  let failed = false;
  for (let page = 1, hasMore = true; hasMore && page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await requestJson(
        fetchImpl,
        urlFor(page),
        { headers: githubHeaders(token) },
        "tracker",
      );
    } catch (error) {
      failed = true;
      warnings.push(
        issues.length === 0
          ? `${what} unavailable (${error instanceof Error ? error.message : "read failed"}); no ${what} collected`
          : `${what} unavailable (${error instanceof Error ? error.message : "read failed"}); collected the first ${issues.length}`,
      );
      return { issues, warnings, capped, failed };
    }
    const entries = Array.isArray(payload) ? payload : [];
    issues.push(...entries.filter(isIssue));
    hasMore = entries.length === PER_PAGE;
    if (!hasMore) break;
    if (page === maxPages) {
      capped = true;
      warnings.push(
        `${what} stopped at the ${maxPages}-page cap; showing the first ${issues.length}`,
      );
    }
  }
  return { issues, warnings, capped, failed };
};

export const fetchOpenIssues = async ({ repo, token, apiBase, fetchImpl, maxPages }) =>
  pagedIssues({
    fetchImpl,
    token,
    maxPages,
    what: "open issues",
    urlFor: (page) => issuesUrl(apiBase, repo, "", { state: "open", per_page: PER_PAGE, page }),
  });

// Maps are found by a label-filtered query across both states: a closed map
// still owns its membership, and the query is bounded by the label, not a
// closed-history sweep.
export const fetchMapIssues = async ({ repo, token, apiBase, fetchImpl, maxPages }) =>
  pagedIssues({
    fetchImpl,
    token,
    maxPages,
    what: "map issues",
    urlFor: (page) =>
      issuesUrl(apiBase, repo, "", {
        state: "all",
        labels: "wayfinder:map",
        per_page: PER_PAGE,
        page,
      }),
  });

// Client tickets (GH-136) are discovered by an open, label-filtered walk —
// one read per client label, the OR of the two — bounded by the label like
// map discovery, never a sweep.
export const fetchOpenIssuesByLabel = async ({
  repo,
  token,
  apiBase,
  fetchImpl,
  label,
  maxPages,
}) =>
  pagedIssues({
    fetchImpl,
    token,
    maxPages,
    what: `open "${label}" issues`,
    urlFor: (page) =>
      issuesUrl(apiBase, repo, "", { state: "open", labels: label, per_page: PER_PAGE, page }),
  });

export const fetchSubIssues = async ({ repo, token, apiBase, issueNumber, fetchImpl, maxPages }) =>
  pagedIssues({
    fetchImpl,
    token,
    maxPages,
    what: `sub-issues of GH-${issueNumber}`,
    urlFor: (page) =>
      issuesUrl(apiBase, repo, `/${issueNumber}/sub_issues`, { per_page: PER_PAGE, page }),
  });

// Native blocked-by lists are read only for issues whose dependency summary
// declares at least one blocker, never as a sweep.
export const fetchBlockedBy = async ({ repo, token, apiBase, issueNumber, fetchImpl, maxPages }) =>
  pagedIssues({
    fetchImpl,
    token,
    maxPages,
    what: `blocked-by list of GH-${issueNumber}`,
    urlFor: (page) =>
      issuesUrl(apiBase, repo, `/${issueNumber}/dependencies/blocked_by`, {
        per_page: PER_PAGE,
        page,
      }),
  });

export const fetchIssue = async ({ repo, token, apiBase, issueNumber, fetchImpl }) => {
  try {
    const payload = await requestJson(
      fetchImpl,
      issuesUrl(apiBase, repo, `/${issueNumber}`),
      { headers: githubHeaders(token) },
      "tracker",
    );
    return isIssue(payload) ? { issue: payload, warnings: [] } : { issue: null, warnings: [] };
  } catch (error) {
    return {
      issue: null,
      warnings: [
        `GH-${issueNumber} unavailable (${error instanceof Error ? error.message : "read failed"}); record not collected`,
      ],
    };
  }
};

// ADR 0009: the closing resolution comment of a closed decision ticket, read
// only for map children the membership enumeration already named — never a
// sweep. Same paged walk and degradation as the issue lists.
export const fetchIssueComments = async ({
  repo,
  token,
  apiBase,
  issueNumber,
  fetchImpl,
  maxPages,
}) => {
  const comments = [];
  const warnings = [];
  for (let page = 1, hasMore = true; hasMore && page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await requestJson(
        fetchImpl,
        issuesUrl(apiBase, repo, `/${issueNumber}/comments`, { per_page: PER_PAGE, page }),
        { headers: githubHeaders(token) },
        "tracker",
      );
    } catch (error) {
      warnings.push(
        comments.length === 0
          ? `GH-${issueNumber} comments unavailable (${error instanceof Error ? error.message : "read failed"}); no resolution collected`
          : `GH-${issueNumber} comments unavailable (${error instanceof Error ? error.message : "read failed"}); collected the first ${comments.length}`,
      );
      return { comments, warnings };
    }
    const entries = Array.isArray(payload) ? payload : [];
    const returned = entries.filter(
      (entry) => entry && typeof entry === "object" && typeof entry.body === "string",
    );
    comments.push(...returned);
    // Same raw-page continuation rule as the issue lists: a malformed entry
    // on a full page must not stop the walk (GH-136).
    hasMore = entries.length === PER_PAGE;
    if (!hasMore) break;
    if (page === maxPages)
      warnings.push(
        `GH-${issueNumber} comments stopped at the ${maxPages}-page cap; showing the first ${comments.length}`,
      );
  }
  return { comments, warnings };
};

export const apiBaseFrom = (apiBaseUrl) => (httpUrl(apiBaseUrl) || GITHUB_API).replace(/\/+$/, "");
