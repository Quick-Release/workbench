import {
  externalTicket,
  httpUrl,
  maxPagesFor,
  requiredServiceValue,
  requestJson,
  serviceLabel,
  statusFromService,
  tokenFor,
} from "./shared.mjs";

const ASANA_API = "https://app.asana.com/api/1.0";
const DEFAULT_TOKEN_ENV = "ASANA_TOKEN";
const DEFAULT_ID_PREFIX = "ASANA-";

const sectionNameFrom = (task) => {
  const membership = task.memberships?.find((entry) => typeof entry?.section?.name === "string");
  return membership?.section?.name?.trim() || "";
};

const fetchPage = async (fetchImpl, token, projectGid, offset, serviceName) => {
  const url = new URL(`${ASANA_API}/projects/${encodeURIComponent(projectGid)}/tasks`);
  url.searchParams.set("limit", "100");
  url.searchParams.set(
    "opt_fields",
    [
      "gid",
      "name",
      "completed",
      "notes",
      "permalink_url",
      "due_on",
      "assignee.name",
      "memberships.section.name",
    ].join(","),
  );
  if (offset) url.searchParams.set("offset", offset);
  return requestJson(
    fetchImpl,
    url,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
    serviceName,
  );
};

const taskRecord = (task, service) => {
  const section = sectionNameFrom(task);
  const status = statusFromService(service, section, task.completed === true);
  const due = task.due_on ? `Due ${task.due_on}` : "";
  const assignee = task.assignee?.name ? `Assigned to ${task.assignee.name}` : "";
  return externalTicket({
    service,
    id: `${service.idPrefix || DEFAULT_ID_PREFIX}${task.gid}`,
    title: task.name,
    status: status.status,
    statusLabel: status.statusLabel,
    statusDetail: [section, due, assignee].filter(Boolean).join(" · "),
    group: service.group || serviceLabel(service),
    lane: section || service.lane || "Asana",
    summary: task.notes,
    sourcePath: `${serviceLabel(service)} / project ${service.projectGid}`,
    sourceUrl: httpUrl(task.permalink_url),
    progress: { done: task.completed === true ? 1 : 0, total: 1 },
  });
};

export const fetchAsana = async (service, { env = process.env, fetchImpl = globalThis.fetch }) => {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const projectGid = requiredServiceValue(service, "projectGid");
  const { token } = tokenFor(service, DEFAULT_TOKEN_ENV, env);
  const label = serviceLabel(service);
  const maxPages = maxPagesFor(service);
  const records = [];
  let offset = "";
  let pages = 0;
  let hasMore = false;

  do {
    const payload = await fetchPage(fetchImpl, token, projectGid, offset, label);
    const tasks = Array.isArray(payload?.data)
      ? payload.data.filter(
          (task) => task && typeof task === "object" && typeof task.gid === "string",
        )
      : [];
    records.push(...tasks.map((task) => taskRecord(task, service)));
    offset = typeof payload?.next_page?.offset === "string" ? payload.next_page.offset : "";
    hasMore = Boolean(offset);
    pages += 1;
  } while (hasMore && pages < maxPages);

  return {
    records,
    sourcePath: `${label} / project ${projectGid}`,
    message: hasMore
      ? `Showing the first ${records.length} tasks (${maxPages} pages); increase maxPages to fetch more.`
      : `${records.length} tasks loaded`,
  };
};
