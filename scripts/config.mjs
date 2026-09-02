import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_THEME = Object.freeze({
  ink: "#f1f3e9",
  muted: "#a5b0a4",
  faint: "#718076",
  bg: "#101715",
  panel: "#17211d",
  "panel-hi": "#1d2b25",
  line: "#2b3a32",
  "line-strong": "#45574b",
  acid: "#c5e86c",
  "acid-dim": "#344525",
  amber: "#f2bf68",
  "amber-dim": "#48371e",
  coral: "#f18476",
  "coral-dim": "#4a2927",
  blue: "#8bc6d8",
  "blue-dim": "#203b43",
  "white-dim": "#d4d8cf",
});

const themeAliases = {
  text: "ink",
  textMuted: "muted",
  textFaint: "faint",
  background: "bg",
  surface: "panel",
  surfaceElevated: "panel-hi",
  border: "line",
  borderStrong: "line-strong",
  accent: "acid",
  accentMuted: "acid-dim",
  warning: "amber",
  warningMuted: "amber-dim",
  danger: "coral",
  dangerMuted: "coral-dim",
  info: "blue",
  infoMuted: "blue-dim",
};

const colorPattern = /^#[0-9a-f]{3,8}$/i;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value, name, { maxLength = 200 } = {}) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${name} must be at most ${maxLength} characters`);
  return result;
};

const httpUrlValue = (value, name, { maxLength = 500 } = {}) => {
  const result = stringValue(value, name, { maxLength });
  if (!result) return undefined;
  let url;
  try {
    url = new URL(result);
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${name} must be an http(s) URL`);
  if (url.username || url.password || url.hash)
    throw new Error(`${name} cannot contain credentials or a fragment`);
  return result.replace(/\/+$/, "");
};

const repositoryUrl = (value) => httpUrlValue(value, "repositoryUrl");

const repositoryName = (value, name) => {
  const result = stringValue(value, name, { maxLength: 300 });
  if (!result) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result))
    throw new Error(`${name} must be in owner/name format`);
  return result;
};

const projectPathValue = (value, name) => {
  const result = stringValue(value, name, { maxLength: 300 });
  if (!result) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/.test(result))
    throw new Error(`${name} must be a project path like group/project`);
  return result;
};

const normalizeTheme = (value) => {
  if (value !== undefined && !isRecord(value)) throw new Error("theme must be an object");
  const theme = { ...DEFAULT_THEME };
  for (const [key, cssVariable] of Object.entries(themeAliases)) {
    const configured = value?.[key];
    if (configured === undefined) continue;
    if (typeof configured !== "string" || !colorPattern.test(configured))
      throw new Error(`theme.${key} must be a hex color`);
    theme[cssVariable] = configured;
  }
  return theme;
};

const normalizeServices = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("services must be an array");
  const ids = new Set();
  return value.map((service, index) => {
    if (!isRecord(service)) throw new Error(`services[${index}] must be an object`);
    if ("token" in service || "accessToken" in service)
      throw new Error(
        `services[${index}] must reference a token with tokenEnv, not store it in the config`,
      );
    const id = stringValue(service.id, `services[${index}].id`, {
      maxLength: 80,
    });
    const type = stringValue(service.type, `services[${index}].type`, {
      maxLength: 40,
    });
    if (!id) throw new Error(`services[${index}].id must be a non-empty string`);
    if (!type) throw new Error(`services[${index}].type must be a non-empty string`);
    if (ids.has(id)) throw new Error(`services[${index}].id must be unique`);
    ids.add(id);
    const tokenEnv = stringValue(service.tokenEnv, `services[${index}].tokenEnv`, {
      maxLength: 80,
    });
    if (tokenEnv && !/^[A-Z][A-Z0-9_]*$/.test(tokenEnv))
      throw new Error(`services[${index}].tokenEnv must be an environment variable name`);
    const serviceType = type.toLowerCase();
    const projectGid =
      serviceType === "asana"
        ? stringValue(service.projectGid, `services[${index}].projectGid`, { maxLength: 200 })
        : undefined;
    const dataSourceId =
      serviceType === "notion"
        ? stringValue(service.dataSourceId, `services[${index}].dataSourceId`, { maxLength: 200 })
        : undefined;
    if (serviceType === "asana" && !projectGid)
      throw new Error(`services[${index}].projectGid must be a non-empty string`);
    if (serviceType === "notion" && !dataSourceId)
      throw new Error(`services[${index}].dataSourceId must be a non-empty string`);
    const repo =
      serviceType === "github"
        ? repositoryName(service.repo, `services[${index}].repo`)
        : undefined;
    if (serviceType === "github" && !repo)
      throw new Error(`services[${index}].repo must be in owner/name format`);
    const projectId =
      serviceType === "gitlab" && service.projectId !== undefined && service.projectId !== null
        ? String(service.projectId).trim()
        : undefined;
    if (projectId !== undefined && !/^\d+$/.test(projectId))
      throw new Error(`services[${index}].projectId must be a numeric GitLab project ID`);
    const projectPath =
      serviceType === "gitlab"
        ? projectPathValue(service.projectPath, `services[${index}].projectPath`)
        : undefined;
    if (serviceType === "gitlab" && !projectId && !projectPath)
      throw new Error(
        `services[${index}] needs a numeric projectId or a projectPath like group/project`,
      );
    if (
      service.notionVersion !== undefined &&
      (typeof service.notionVersion !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(service.notionVersion))
    )
      throw new Error(`services[${index}].notionVersion must be an ISO date`);
    const apiBaseUrl = httpUrlValue(service.apiBaseUrl, `services[${index}].apiBaseUrl`);
    return {
      ...service,
      id,
      type: serviceType,
      ...(tokenEnv ? { tokenEnv } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    };
  });
};

export const loadWorkbenchConfig = async (rootDirectory) => {
  const path = join(rootDirectory, "workbench.config.json");
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Could not read ${path}`);
    text = "";
  }
  if (!text.trim()) {
    return {
      projectName: undefined,
      repositoryUrl: undefined,
      theme: { ...DEFAULT_THEME },
      services: [],
      path,
    };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Could not parse ${path}: ${detail}`);
  }
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);

  return {
    projectName: stringValue(value.projectName, "projectName", {
      maxLength: 100,
    }),
    repositoryUrl: repositoryUrl(value.repositoryUrl),
    theme: normalizeTheme(value.theme),
    services: normalizeServices(value.services),
    path,
  };
};
