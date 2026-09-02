import { fetchAsana } from "./asana.mjs";
import { fetchGitHub } from "./github.mjs";
import { fetchGitLab } from "./gitlab.mjs";
import { fetchNotion } from "./notion.mjs";
import { isEnabled, serviceLabel, serviceStatus } from "./shared.mjs";

const adapters = {
  asana: fetchAsana,
  notion: fetchNotion,
  github: fetchGitHub,
  gitlab: fetchGitLab,
};

const safeMessage = (error) => (error instanceof Error ? error.message : "unknown service error");

export const fetchConfiguredServices = async (
  services,
  { env = process.env, fetchImpl = globalThis.fetch } = {},
) => {
  const records = [];
  const statuses = [];
  for (const service of services) {
    const label = serviceLabel(service);
    if (!isEnabled(service)) {
      statuses.push(
        serviceStatus({
          service,
          status: "skipped",
          message: "disabled in workbench.config.json",
        }),
      );
      continue;
    }
    const adapter = adapters[service.type];
    if (!adapter) {
      statuses.push(
        serviceStatus({
          service,
          status: "error",
          message: `unsupported service type: ${service.type}`,
        }),
      );
      continue;
    }
    try {
      const result = await adapter(service, { env, fetchImpl });
      records.push(...result.records);
      statuses.push(
        serviceStatus({
          service,
          status: "connected",
          itemCount: result.records.length,
          message: result.message,
          sourcePath: result.sourcePath,
        }),
      );
    } catch (error) {
      const message = safeMessage(error);
      console.warn(`[workbench] ${label}: ${message}`);
      statuses.push(
        serviceStatus({
          service,
          status: "error",
          message,
        }),
      );
    }
  }
  return { records, statuses };
};

export { fetchAsana, fetchNotion, fetchGitHub, fetchGitLab };
