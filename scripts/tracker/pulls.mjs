import { requestJson } from "../services/shared.mjs";
import { githubHeaders, PER_PAGE } from "./issues.mjs";

// The pull-request record family's read layer: one paged walk of the host
// repo's open pull requests, same page cap and fail-soft degradation as the
// issue reads. Pull requests are deliberately absent from the issue sweep —
// the issues endpoint mixes them in and every consumer there filters them
// out — so they get this dedicated read whose records keep their own shape.

const pullsUrl = (apiBase, repo, page) => {
  const url = new URL(`${apiBase}/repos/${repo}/pulls`);
  url.searchParams.set("state", "open");
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  return url;
};

export const pullRequestFromApi = (entry) => ({
  number: entry.number,
  title: entry.title ?? "",
  url: entry.html_url ?? "",
  head: entry.head?.ref ?? "",
  base: entry.base?.ref ?? "",
  author: entry.user?.login ?? "",
  isDraft: Boolean(entry.draft),
  body: entry.body ?? "",
});

export const fetchOpenPullRequests = async ({ repo, token, apiBase, fetchImpl, maxPages }) => {
  const pulls = [];
  const warnings = [];
  for (let page = 1, hasMore = true; hasMore && page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await requestJson(
        fetchImpl,
        pullsUrl(apiBase, repo, page),
        { headers: githubHeaders(token) },
        "tracker",
      );
    } catch (error) {
      warnings.push(
        pulls.length === 0
          ? `open pull requests unavailable (${error instanceof Error ? error.message : "read failed"}); no pull requests collected`
          : `open pull requests unavailable (${error instanceof Error ? error.message : "read failed"}); collected the first ${pulls.length}`,
      );
      return { pulls, warnings };
    }
    const returned = Array.isArray(payload) ? payload.map(pullRequestFromApi) : [];
    pulls.push(...returned);
    hasMore = returned.length === PER_PAGE;
    if (!hasMore) break;
    if (page === maxPages)
      warnings.push(
        `open pull requests stopped at the ${maxPages}-page cap; showing the first ${pulls.length}`,
      );
  }
  return { pulls, warnings };
};
