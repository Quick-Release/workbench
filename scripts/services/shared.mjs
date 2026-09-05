const statusLabels = {
  complete: "complete",
  "in-progress": "in-progress",
  ready: "ready-for-agent",
  "needs-development": "needs-development",
  gated: "ready-for-human",
  blocked: "blocked",
  planned: "needs-triage",
  deferred: "deferred",
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value, fallback = "") => (typeof value === "string" ? value.trim() : fallback);

export const serviceLabel = (service) =>
  stringValue(service.label) ||
  `${service.type.slice(0, 1).toLocaleUpperCase()}${service.type.slice(1)}`;

export const requiredServiceValue = (service, key) => {
  const value = stringValue(service[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
};

export const tokenFor = (service, defaultName, env) => {
  const tokenEnv = stringValue(service.tokenEnv) || defaultName;
  if (!/^[A-Z][A-Z0-9_]*$/.test(tokenEnv))
    throw new Error("tokenEnv must be an environment variable name");
  const token = stringValue(env[tokenEnv]);
  if (!token) throw new Error(`missing ${tokenEnv}`);
  return { token, tokenEnv };
};

export const maxPagesFor = (service) => {
  const value = service.maxPages ?? 100;
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new Error("maxPages must be an integer from 1 to 100");
  return value;
};

export const requestJson = async (fetchImpl, url, options, serviceName) => {
  const signal =
    typeof globalThis.AbortSignal?.timeout === "function"
      ? globalThis.AbortSignal.timeout(30_000)
      : undefined;
  const response = await fetchImpl(url, {
    ...options,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`${serviceName} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${serviceName} returned invalid JSON`);
  }
};

const normalized = (value) => stringValue(value).toLocaleLowerCase();

export const statusFor = (value, completed = false) => {
  if (completed) return { status: "complete", statusLabel: "complete" };
  const raw = stringValue(value);
  const status = normalized(raw);
  if (status.includes("wontfix")) return { status: "complete", statusLabel: "wontfix" };
  if (status.includes("needs-info")) return { status: "gated", statusLabel: "needs-info" };
  if (
    status.includes("ready-for-human") ||
    status.includes("human gate") ||
    status.includes("gated") ||
    status.includes("approval")
  )
    return { status: "gated", statusLabel: "ready-for-human" };
  if (status.includes("ready-for-agent") || status === "ready")
    return { status: "ready", statusLabel: "ready-for-agent" };
  if (status.includes("blocked")) return { status: "blocked", statusLabel: "blocked" };
  if (status.includes("needs-development") || status.includes("needs development"))
    return { status: "needs-development", statusLabel: "needs-development" };
  if (status.includes("in-progress") || status.includes("in progress") || status.includes("active"))
    return { status: "in-progress", statusLabel: "in-progress" };
  if (status.includes("deferred")) return { status: "deferred", statusLabel: "deferred" };
  if (
    status.includes("complete") ||
    status.includes("completed") ||
    status.includes("done") ||
    status.includes("closed")
  )
    return { status: "complete", statusLabel: "complete" };
  return { status: "planned", statusLabel: statusLabels.planned };
};

export const statusFromService = (service, value, completed = false) => {
  const statusMap = isRecord(service.statusMap) ? service.statusMap : {};
  return statusFor(statusMap[value] ?? value, completed);
};

export const statusFromLabels = (service, labels, completed = false) => {
  if (completed) return { status: "complete", statusLabel: "complete" };
  const names = (Array.isArray(labels) ? labels : [])
    .map((label) => stringValue(typeof label === "string" ? label : label?.name))
    .filter(Boolean);
  for (const name of names) {
    const candidate = statusFromService(service, name, false);
    if (candidate.status !== "planned") return candidate;
  }
  return { status: "planned", statusLabel: statusLabels.planned };
};

export const plainText = (value) =>
  stringValue(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const httpUrl = (value) => {
  const candidate = stringValue(value);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
};

export const shorten = (value, limit = 240) => {
  const text = plainText(value);
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
};

export const externalTicket = ({
  service,
  id,
  title,
  status,
  statusLabel,
  statusDetail = "",
  group,
  lane,
  summary,
  sourcePath,
  sourceUrl,
  progress,
}) => ({
  id,
  title: shorten(title, 180) || "Untitled task",
  status,
  statusLabel,
  statusDetail,
  group: group || serviceLabel(service),
  lane: lane || serviceLabel(service),
  summary: shorten(summary) || "No summary recorded.",
  sourcePath,
  sourceUrl,
  kind: "external",
  externalSource: serviceLabel(service),
  progress: progress || { done: 0, total: 0 },
});

export const serviceStatus = ({
  service,
  status,
  itemCount = 0,
  message = "",
  sourcePath = "",
}) => ({
  id: service.id,
  type: service.type,
  label: serviceLabel(service),
  status,
  itemCount,
  message,
  sourcePath,
});

export const isEnabled = (service) => service.enabled !== false;
