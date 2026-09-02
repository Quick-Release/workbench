import {
  externalTicket,
  httpUrl,
  maxPagesFor,
  plainText,
  requiredServiceValue,
  requestJson,
  serviceLabel,
  statusFromService,
  tokenFor,
} from "./shared.mjs";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const DEFAULT_TOKEN_ENV = "NOTION_TOKEN";
const DEFAULT_ID_PREFIX = "NOTION-";
const DEFAULT_PROPERTIES = Object.freeze({
  title: "Name",
  status: "Status",
  group: "Project",
  lane: "Section",
  id: "",
  dependencies: "Dependencies",
  summary: "Description",
});

const richText = (items) =>
  Array.isArray(items)
    ? items.map((item) => item?.plain_text || item?.text?.content || "").join("")
    : "";

const propertyText = (property) => {
  if (!property) return "";
  if (property.type === "title") return richText(property.title);
  if (property.type === "rich_text") return richText(property.rich_text);
  if (property.type === "select") return property.select?.name || "";
  if (property.type === "status") return property.status?.name || "";
  if (property.type === "multi_select")
    return property.multi_select?.map((item) => item.name).join(", ") || "";
  if (property.type === "checkbox") return property.checkbox === true ? "true" : "false";
  if (property.type === "number")
    return property.number === null || property.number === undefined ? "" : String(property.number);
  if (property.type === "url") return property.url || "";
  if (property.type === "email") return property.email || "";
  if (property.type === "phone_number") return property.phone_number || "";
  if (property.type === "date") return property.date?.start || "";
  if (property.type === "people")
    return property.people?.map((person) => person.name || person.id).join(", ") || "";
  if (property.type === "relation")
    return property.relation?.map((relation) => relation.id).join(", ") || "";
  if (property.type === "created_time") return property.created_time || "";
  if (property.type === "last_edited_time") return property.last_edited_time || "";
  if (property.type === "formula") return formulaText(property.formula);
  if (property.type === "unique_id") {
    const prefix = property.unique_id?.prefix || "";
    const number = property.unique_id?.number;
    return number === undefined ? "" : `${prefix}${number}`;
  }
  return "";
};

const formulaText = (formula) => {
  if (!formula) return "";
  if (formula.type === "string") return formula.string || "";
  if (formula.type === "number")
    return formula.number === null || formula.number === undefined ? "" : String(formula.number);
  if (formula.type === "boolean") return formula.boolean ? "true" : "false";
  if (formula.type === "date") return formula.date?.start || "";
  return "";
};

const configuredProperties = (service) => ({
  ...DEFAULT_PROPERTIES,
  ...(typeof service.properties === "object" && service.properties !== null
    ? service.properties
    : {}),
});

const firstTitle = (properties) => {
  const entry = Object.values(properties || {}).find((property) => property?.type === "title");
  return propertyText(entry);
};

const pageRecord = (page, service) => {
  const properties = page.properties || {};
  const names = configuredProperties(service);
  const title = propertyText(properties[names.title]) || firstTitle(properties);
  const rawStatus = propertyText(properties[names.status]);
  const status = statusFromService(service, rawStatus, rawStatus.toLocaleLowerCase() === "true");
  const group = propertyText(properties[names.group]);
  const lane = propertyText(properties[names.lane]);
  const dependencies = propertyText(properties[names.dependencies]);
  const summary = propertyText(properties[names.summary]);
  const configuredId = names.id ? propertyText(properties[names.id]) : "";
  const pageId = plainText(page.id).replaceAll("-", "");
  return externalTicket({
    service,
    id: configuredId || `${service.idPrefix || DEFAULT_ID_PREFIX}${pageId}`,
    title,
    status: status.status,
    statusLabel: status.statusLabel,
    statusDetail: rawStatus,
    group: group || service.group || serviceLabel(service),
    lane: lane || service.lane || "Notion",
    dependencies,
    summary,
    sourcePath: `${serviceLabel(service)} / data source ${service.dataSourceId}`,
    sourceUrl: httpUrl(page.url || page.public_url),
    progress: {
      done: status.status === "complete" ? 1 : 0,
      total: 1,
    },
  });
};

const fetchPage = async (fetchImpl, token, dataSourceId, cursor, service) => {
  const url = `${NOTION_API}/data_sources/${encodeURIComponent(dataSourceId)}/query`;
  const body = {
    page_size: 100,
    result_type: "page",
    ...(cursor ? { start_cursor: cursor } : {}),
    ...(service.filter ? { filter: service.filter } : {}),
    ...(service.sorts ? { sorts: service.sorts } : {}),
  };
  return requestJson(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": service.notionVersion || NOTION_VERSION,
      },
      body: JSON.stringify(body),
    },
    serviceLabel(service),
  );
};

export const fetchNotion = async (service, { env = process.env, fetchImpl = globalThis.fetch }) => {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const dataSourceId = requiredServiceValue(service, "dataSourceId");
  const { token } = tokenFor(service, DEFAULT_TOKEN_ENV, env);
  const maxPages = maxPagesFor(service);
  const records = [];
  let cursor = "";
  let pages = 0;
  let hasMore = false;

  do {
    const payload = await fetchPage(fetchImpl, token, dataSourceId, cursor, service);
    const pagesInResponse = Array.isArray(payload?.results)
      ? payload.results.filter(
          (page) => page && typeof page === "object" && typeof page.id === "string",
        )
      : [];
    records.push(...pagesInResponse.map((page) => pageRecord(page, service)));
    cursor = typeof payload?.next_cursor === "string" ? payload.next_cursor : "";
    hasMore = Boolean(cursor && payload?.has_more);
    pages += 1;
  } while (hasMore && pages < maxPages);

  return {
    records,
    sourcePath: `${serviceLabel(service)} / data source ${dataSourceId}`,
    message: hasMore
      ? `Showing the first ${records.length} tasks (${maxPages} pages); increase maxPages to fetch more.`
      : `${records.length} tasks loaded`,
  };
};
