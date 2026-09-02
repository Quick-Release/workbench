import {
  externalTicket,
  httpUrl,
  maxPagesFor,
  requiredServiceValue,
  requestJson,
  serviceLabel,
  statusFromLabels,
  statusFromService,
  tokenFor,
} from "./shared.mjs";

const GITHUB_API = "https://api.github.com";
const DEFAULT_TOKEN_ENV = "GITHUB_TOKEN";
const DEFAULT_ID_PREFIX = "GH-";
const GITHUB_API_VERSION = "2022-11-28";
const PER_PAGE = 100;

const labelNames = (issue) =>
  (Array.isArray(issue.labels) ? issue.labels : [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());

const fetchPage = async (fetchImpl, token, apiBase, repo, page, serviceName) => {
  const [owner, name] = repo.split("/");
  const url = new URL(
    `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`,
  );
  url.searchParams.set("state", "open");
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  return requestJson(
    fetchImpl,
    url,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        Authorization: `Bearer ${token}`,
      },
    },
    serviceName,
  );
};

const issueRecord = (issue, service, repo) => {
  const closed = issue.state === "closed";
  const labels = labelNames(issue);
  const status =
    closed && issue.state_reason === "not_planned"
      ? statusFromService(service, "wontfix", false)
      : statusFromLabels(service, labels, closed);
  const milestone = typeof issue.milestone?.title === "string" ? issue.milestone.title.trim() : "";
  const assignee = issue.assignee?.login ? `Assigned to ${issue.assignee.login}` : "";
  return externalTicket({
    service,
    id: `${service.idPrefix || DEFAULT_ID_PREFIX}${issue.number}`,
    title: issue.title,
    status: status.status,
    statusLabel: status.statusLabel,
    statusDetail: [milestone, assignee].filter(Boolean).join(" · "),
    group: service.group || serviceLabel(service),
    lane: labels[0] || service.lane || "GitHub",
    summary: issue.body,
    sourcePath: `${serviceLabel(service)} / repo ${repo}`,
    sourceUrl: httpUrl(issue.html_url),
    progress: { done: closed ? 1 : 0, total: 1 },
  });
};

export const fetchGitHub = async (service, { env = process.env, fetchImpl = globalThis.fetch }) => {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const repo = requiredServiceValue(service, "repo");
  const { token } = tokenFor(service, DEFAULT_TOKEN_ENV, env);
  const label = serviceLabel(service);
  const apiBase = (httpUrl(service.apiBaseUrl) || GITHUB_API).replace(/\/+$/, "");
  const maxPages = maxPagesFor(service);
  const records = [];
  let page = 1;
  let pages = 0;
  let hasMore = false;

  do {
    const payload = await fetchPage(fetchImpl, token, apiBase, repo, page, label);
    const returned = Array.isArray(payload) ? payload : [];
    const issues = returned.filter(
      (issue) =>
        issue &&
        typeof issue === "object" &&
        typeof issue.number === "number" &&
        !issue.pull_request,
    );
    records.push(...issues.map((issue) => issueRecord(issue, service, repo)));
    hasMore = returned.length === PER_PAGE;
    pages += 1;
    page += 1;
  } while (hasMore && pages < maxPages);

  return {
    records,
    sourcePath: `${label} / repo ${repo}`,
    message: hasMore
      ? `Showing the first ${records.length} issues (${maxPages} pages); increase maxPages to fetch more.`
      : `${records.length} issues loaded`,
  };
};
