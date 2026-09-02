import {
  externalTicket,
  httpUrl,
  maxPagesFor,
  requestJson,
  serviceLabel,
  statusFromLabels,
  tokenFor,
} from "./shared.mjs";

const GITLAB_API = "https://gitlab.com/api/v4";
const DEFAULT_TOKEN_ENV = "GITLAB_TOKEN";
const DEFAULT_ID_PREFIX = "GL-";
const PER_PAGE = 100;

const projectIdentifier = (service) => {
  const raw = service.projectId ?? service.projectPath;
  const value = typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "";
  if (!value) throw new Error("projectId or projectPath is required");
  return value;
};

const labelNames = (issue) =>
  (Array.isArray(issue.labels) ? issue.labels : [])
    .map((label) => (typeof label === "string" ? label.trim() : ""))
    .filter(Boolean);

const fetchPage = async (fetchImpl, token, apiBase, project, page, serviceName) => {
  const url = new URL(`${apiBase}/projects/${encodeURIComponent(project)}/issues`);
  url.searchParams.set("state", "opened");
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  return requestJson(
    fetchImpl,
    url,
    {
      headers: {
        "PRIVATE-TOKEN": token,
      },
    },
    serviceName,
  );
};

const issueRecord = (issue, service, project) => {
  const closed = issue.state === "closed";
  const labels = labelNames(issue);
  const status = statusFromLabels(service, labels, closed);
  const assignees = (Array.isArray(issue.assignees) ? issue.assignees : [])
    .map((person) => (typeof person?.name === "string" ? person.name : person?.username))
    .filter((name) => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());
  const milestone = typeof issue.milestone?.title === "string" ? issue.milestone.title.trim() : "";
  const due = typeof issue.due_date === "string" && issue.due_date ? `Due ${issue.due_date}` : "";
  const assigned = assignees.length ? `Assigned to ${assignees.join(", ")}` : "";
  return externalTicket({
    service,
    id: `${service.idPrefix || DEFAULT_ID_PREFIX}${issue.iid}`,
    title: issue.title,
    status: status.status,
    statusLabel: status.statusLabel,
    statusDetail: [milestone, due, assigned].filter(Boolean).join(" · "),
    group: service.group || serviceLabel(service),
    lane: labels[0] || service.lane || "GitLab",
    summary: issue.description,
    sourcePath: `${serviceLabel(service)} / project ${project}`,
    sourceUrl: httpUrl(issue.web_url),
    progress: { done: closed ? 1 : 0, total: 1 },
  });
};

export const fetchGitLab = async (service, { env = process.env, fetchImpl = globalThis.fetch }) => {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const project = projectIdentifier(service);
  const { token } = tokenFor(service, DEFAULT_TOKEN_ENV, env);
  const label = serviceLabel(service);
  const apiBase = (httpUrl(service.apiBaseUrl) || GITLAB_API).replace(/\/+$/, "");
  const maxPages = maxPagesFor(service);
  const records = [];
  let page = 1;
  let pages = 0;
  let hasMore = false;

  do {
    const payload = await fetchPage(fetchImpl, token, apiBase, project, page, label);
    const returned = Array.isArray(payload) ? payload : [];
    const issues = returned.filter(
      (issue) => issue && typeof issue === "object" && typeof issue.iid === "number",
    );
    records.push(...issues.map((issue) => issueRecord(issue, service, project)));
    hasMore = returned.length === PER_PAGE;
    pages += 1;
    page += 1;
  } while (hasMore && pages < maxPages);

  return {
    records,
    sourcePath: `${label} / project ${project}`,
    message: hasMore
      ? `Showing the first ${records.length} issues (${maxPages} pages); increase maxPages to fetch more.`
      : `${records.length} issues loaded`,
  };
};
