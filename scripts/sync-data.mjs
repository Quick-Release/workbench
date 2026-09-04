import { execFileSync } from "node:child_process";
import { loadWorkbenchConfig } from "./config.mjs";
import { SELF_REPOSITORY_URL, servicesForSource } from "./self-defaults.mjs";
import { fetchConfiguredServices } from "./services/index.mjs";
import {
  collectSessionUsage,
  resolveSessionsDatabasePath,
  sessionUsageDisabled,
} from "./sessions.mjs";
import { demoSourceRoot, resolveSourceRoot } from "./source-root.mjs";
import { collectTrackerState } from "./tracker/index.mjs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const directoryExists = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const fileExists = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const command = (name, args, fallback, cwd) => {
  try {
    return (
      execFileSync(name, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        ...(cwd ? { cwd } : {}),
      }).trim() || fallback
    );
  } catch {
    return fallback;
  }
};

const superprojectDirectory = command(
  "git",
  ["-C", appDirectory, "rev-parse", "--show-superproject-working-tree"],
  "",
);
const gitDirectory = command("git", ["-C", appDirectory, "rev-parse", "--show-toplevel"], "");
const fallbackGitDirectory = command(
  "git",
  ["-C", process.cwd(), "rev-parse", "--show-toplevel"],
  "",
);
const demoRequest = process.env.WORKBENCH_DEMO_SOURCE;
const demoPath = demoSourceRoot(demoRequest);
const { rootDirectory, usingDemoSource, usingSelfRepository } = resolveSourceRoot({
  appDirectory,
  configuredSourceRoot: process.env.WORKBENCH_SOURCE_ROOT,
  superprojectDirectory,
  gitDirectory,
  demoDirectory: demoRequest && (await directoryExists(demoPath)) ? demoPath : "",
  fallbackDirectory: process.cwd(),
  fallbackGitDirectory,
});
const docsDirectory = join(rootDirectory, "docs");
const plansDirectory = join(docsDirectory, "plans");
const changesDirectory = join(rootDirectory, "openspec/changes");
const outputPath = join(appDirectory, "src/data.generated.ts");

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

const skillLabels = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"];
const skillLabelPattern = new RegExp(`\\b(${skillLabels.join("|")})\\b`, "i");

const statusOrder = {
  gated: 0,
  blocked: 1,
  "needs-development": 2,
  ready: 3,
  "in-progress": 4,
  planned: 5,
  deferred: 6,
  complete: 7,
};

const canonicalStatus = {
  complete: "complete",
  "in-progress": "in-progress",
  "needs-development": "needs-development",
  "human-gate": "gated",
  deferred: "deferred",
};

const readDirectory = async (directory) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

const walk = async (directory) => {
  const entries = await readDirectory(directory);
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
};

const readText = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};

const relativePath = (path) => relative(rootDirectory, path).split("\\").join("/");

const cleanText = (value) =>
  value
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const shorten = (value, limit = 240) => {
  const text = cleanText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
};

const firstHeading = (text) => {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? cleanText(match[1]) : "";
};

const sectionParagraph = (text, names) => {
  const lines = text.split(/\r?\n/);
  const wanted = names.map((name) => name.toLocaleLowerCase());
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^##\s+(.+)$/);
    if (!heading || !wanted.includes(cleanText(heading[1]).toLocaleLowerCase())) continue;
    const section = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^##\s+/.test(lines[next])) break;
      section.push(lines[next]);
    }
    const paragraph = section
      .join("\n")
      .split(/\n\s*\n/)
      .map((part) => shorten(part))
      .find(Boolean);
    if (paragraph) return paragraph;
  }
  return "";
};

const firstParagraph = (text) =>
  text
    .split(/\n\s*\n/)
    .map((part) => shorten(part))
    .find((part) => part && !part.startsWith("#")) || "";

const summaryFrom = (text) =>
  sectionParagraph(text, [
    "Outcome",
    "Objective",
    "Why",
    "What Changes",
    "Conclusion",
    "Executive summary",
  ]) ||
  firstParagraph(text) ||
  "No summary recorded.";

const rawStatusFrom = (text) => {
  const match = text.match(/^\s*(?:[-*]\s*)?(?:\*\*)?Status(?:\*\*)?\s*[:：]\s*(.+)$/im);
  return match ? shorten(match[1], 180) : "Not explicitly stated";
};

const statusLabelFrom = (rawStatus, status) => {
  const match = rawStatus.match(skillLabelPattern);
  if (match) return match[1].toLocaleLowerCase();
  return statusLabels[status];
};

const normalizeStatus = (rawStatus) => {
  const status = rawStatus.toLocaleLowerCase();
  if (status.includes("deferred")) return "deferred";
  if (status.includes("blocked")) return "blocked";
  if (
    status.includes("needs-info") ||
    status.includes("ready-for-human") ||
    status.includes("human gate") ||
    status.includes("externally gated") ||
    status.includes("external")
  )
    return "gated";
  if (status.includes("ready-for-agent") || status.includes("ready for agent")) return "ready";
  if (status.includes("needs-development") || status.includes("needs development"))
    return "needs-development";
  if (
    status.includes("complete") ||
    status.includes("implemented") ||
    status.includes("accepted") ||
    status === "closed"
  ) {
    if (status.includes("remains in progress")) return "in-progress";
    return "complete";
  }
  if (
    status.includes("in-progress") ||
    status.includes("in progress") ||
    status.includes("active implementation") ||
    status.includes("active")
  )
    return "in-progress";
  return "planned";
};

const progressFrom = (text) => {
  const checks = [...text.matchAll(/^\s*-\s+\[([ xX~!])\]/gm)].map((match) => match[1]);
  return {
    done: checks.filter((mark) => mark.toLocaleLowerCase() === "x").length,
    total: checks.length,
  };
};

const dependenciesFrom = (text) => {
  const match = text.match(/^\s*(?:[-*]\s*)?(?:Dependencies|Blocked by|Depends on)\s*:\s*(.+)$/im);
  return match ? shorten(match[1], 180) : "—";
};

const humanize = (value) =>
  value
    .split("/")
    .map((part) =>
      part
        .replaceAll("-", " ")
        .replaceAll("_", " ")
        .replace(/\b\w/g, (character) => character.toLocaleUpperCase()),
    )
    .join(" / ");

const ticketIdFrom = (text, filename) => {
  const headingMatch = text.match(/^#\s+([A-Z0-9][A-Z0-9-]*-\d+)\b/m);
  if (headingMatch) return headingMatch[1];
  const filenameMatch = filename.match(/^([A-Z0-9][A-Z0-9-]*-\d+)/i);
  return filenameMatch ? filenameMatch[1].toUpperCase() : "";
};

const titleFrom = (text, id, filename) => {
  const heading = firstHeading(text);
  const title = heading.replace(new RegExp(`^${id}\\s*[—–:-]?\\s*`, "i"), "").trim();
  return title || humanize(filename.replace(/\.md$/i, ""));
};

const repositoryWebUrlFrom = (remote) => {
  const sshMatch = remote.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`.replace(/\.git$/, "");
  if (/^https?:\/\//.test(remote)) return remote.replace(/\.git$/, "");
  return "";
};

const repositoryNameFrom = (repositoryUrl) => {
  if (!repositoryUrl) return basename(rootDirectory);
  try {
    return new URL(repositoryUrl).pathname.replace(/^\/+|\/+$/g, "");
  } catch {
    return basename(rootDirectory);
  }
};

const sourceUrlFor = (repositoryUrl, branch, path) =>
  repositoryUrl ? `${repositoryUrl}/blob/${encodeURIComponent(branch)}/${path}` : "";

const planGroupFrom = (path) => {
  const parts = relativePath(path).split("/");
  const plansIndex = parts.indexOf("plans");
  const ticketsIndex = parts.indexOf("tickets");
  if (plansIndex === -1 || ticketsIndex === -1) return "Other";
  return humanize(parts.slice(plansIndex + 1, ticketsIndex).join("/"));
};

const recordFromFile = async (path, repositoryUrl, branch, kind = "plan-ticket") => {
  const text = await readText(path);
  const filename = path.split(/[\\/]/).pop() || "";
  const id = ticketIdFrom(text, filename);
  if (!id) return null;
  const rawStatus = rawStatusFrom(text);
  const status = normalizeStatus(rawStatus);
  const statusLabel = statusLabelFrom(rawStatus, status);
  const group = planGroupFrom(path);
  return {
    id,
    title: titleFrom(text, id, filename),
    status,
    statusLabel,
    statusDetail: rawStatus === "Not explicitly stated" ? "" : rawStatus,
    group,
    lane: sectionParagraph(text, ["Phase", "Milestone", "Lane"]) || "Planning",
    dependencies: dependenciesFrom(text),
    summary: summaryFrom(text),
    sourcePath: relativePath(path),
    sourceUrl: sourceUrlFor(repositoryUrl, branch, relativePath(path)),
    kind,
    progress: progressFrom(text),
  };
};

const parseDashboardLedger = async (repositoryUrl, branch) => {
  const ledgerPath = join(docsDirectory, "dashboard-plan/status.md");
  const text = await readText(ledgerPath);
  const records = [];
  const rowPattern = /^\|\s*(BQ-\d+)\s*\|\s*`([^`]+)`\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|/gm;
  for (const match of text.matchAll(rowPattern)) {
    const [, id, rawStatus, title, link] = match;
    const sourcePath = resolve(dirname(ledgerPath), (link || "").split("#")[0]);
    const sourceText = await readText(sourcePath);
    const status = canonicalStatus[rawStatus] || normalizeStatus(rawStatus);
    records.push({
      id,
      title: cleanText(title),
      status,
      statusLabel: statusLabelFrom(rawStatus, status),
      statusDetail: `Canonical ledger: ${rawStatus}`,
      group: "Dashboard",
      lane: sectionParagraph(sourceText, ["Milestone", "Phase", "Lane"]) || "Dashboard backlog",
      dependencies: dependenciesFrom(sourceText),
      summary: sourceText ? summaryFrom(sourceText) : "No ticket file found.",
      sourcePath: relativePath(sourcePath),
      sourceUrl: sourceUrlFor(repositoryUrl, branch, relativePath(sourcePath)),
      kind: "ledger",
      progress: progressFrom(sourceText),
    });
  }
  return records;
};

const sortTickets = (tickets) =>
  tickets.sort((left, right) => {
    const statusDifference = statusOrder[left.status] - statusOrder[right.status];
    return statusDifference || left.id.localeCompare(right.id);
  });

const parsePlans = async (directoryNames, filesByDirectory, tickets, repositoryUrl, branch) => {
  const plans = [];
  for (const directory of directoryNames) {
    const sourceName = ["README.md", "plan.md", "roadmap.md"].find((name) =>
      filesByDirectory.get(directory)?.has(name),
    );
    if (!sourceName) continue;
    const sourcePath = join(plansDirectory, directory, sourceName);
    const sourceText = await readText(sourcePath);
    const planTickets = tickets.filter((ticket) =>
      ticket.sourcePath.startsWith(`docs/plans/${directory}/`),
    );
    const completeTicketCount = planTickets.filter((ticket) => ticket.status === "complete").length;
    const rawStatus = rawStatusFrom(sourceText);
    const status = normalizeStatus(rawStatus);
    plans.push({
      id: directory.toUpperCase(),
      title: firstHeading(sourceText) || humanize(directory),
      status,
      statusLabel: statusLabelFrom(rawStatus, status),
      statusDetail: rawStatus === "Not explicitly stated" ? "" : rawStatus,
      stream: humanize(directory),
      ticketCount: planTickets.length,
      openTicketCount: planTickets.length - completeTicketCount,
      completeTicketCount,
      summary: summaryFrom(sourceText),
      sourcePath: relativePath(sourcePath),
      sourceUrl: sourceUrlFor(repositoryUrl, branch, relativePath(sourcePath)),
    });
  }
  return plans.sort(
    (left, right) =>
      right.openTicketCount - left.openTicketCount || left.title.localeCompare(right.title),
  );
};

const parseSpecChanges = async (changeDirectories, repositoryUrl, branch) => {
  const changes = [];
  for (const directory of changeDirectories) {
    const proposalPath = join(changesDirectory, directory, "proposal.md");
    const tasksPath = join(changesDirectory, directory, "tasks.md");
    const proposal = await readText(proposalPath);
    const tasks = await readText(tasksPath);
    if (!proposal) continue;
    const marks = [...tasks.matchAll(/^\s*-\s+\[([ xX~!])\]/gm)].map((match) => match[1]);
    const completeTaskCount = marks.filter((mark) => mark.toLocaleLowerCase() === "x").length;
    const taskCount = marks.length;
    const status =
      taskCount > 0 && completeTaskCount === taskCount
        ? "complete"
        : taskCount > 0
          ? "in-progress"
          : "planned";
    changes.push({
      id: directory,
      title: firstHeading(proposal) || humanize(directory),
      status,
      statusLabel: statusLabels[status],
      summary: summaryFrom(proposal),
      taskCount,
      completeTaskCount,
      sourcePath: relativePath(proposalPath),
      sourceUrl: sourceUrlFor(repositoryUrl, branch, relativePath(proposalPath)),
    });
  }
  return changes.sort((left, right) => left.title.localeCompare(right.title));
};

const main = async () => {
  if (usingDemoSource) console.log(`Demo data requested; reading ${rootDirectory}.`);
  else if (demoRequest) console.log(`Demo source ${demoPath} not used; reading ${rootDirectory}.`);
  const config = await loadWorkbenchConfig(rootDirectory);
  const hasConfig = await fileExists(config.path);
  const remote = command("git", ["config", "--get", "remote.origin.url"], "", rootDirectory);
  const repositoryUrl =
    process.env.WORKBENCH_REPOSITORY_URL ||
    config.repositoryUrl ||
    (usingSelfRepository ? SELF_REPOSITORY_URL : repositoryWebUrlFrom(remote));
  const repo = repositoryNameFrom(repositoryUrl);
  const projectName =
    process.env.WORKBENCH_PROJECT_NAME || config.projectName || repo.split("/").pop() || repo;
  const branch = command("git", ["branch", "--show-current"], "local", rootDirectory);
  const commit = command("git", ["rev-parse", "HEAD"], "uncommitted", rootDirectory);
  const snapshot = command(
    "git",
    ["show", "-s", "--format=%cI", "HEAD"],
    new Date().toISOString(),
    rootDirectory,
  );
  const { records: serviceTickets, statuses: serviceStatuses } = await fetchConfiguredServices(
    servicesForSource(config.services, usingSelfRepository && !hasConfig),
  );

  const sessions = config.sessions.enabled
    ? collectSessionUsage({
        databasePath: resolveSessionsDatabasePath(config.sessions.databasePath),
        sourceRoot: rootDirectory,
      })
    : sessionUsageDisabled();

  const tracker = await collectTrackerState({
    repo,
    vocabularyPath: join(rootDirectory, "docs", "agents", "workflow-labels.md"),
  });

  const planFiles = (await walk(plansDirectory)).filter((path) => path.endsWith(".md"));
  const planTicketFiles = planFiles.filter((path) => relativePath(path).includes("/tickets/"));
  const genericTickets = [];
  for (const path of planTicketFiles) {
    const record = await recordFromFile(path, repositoryUrl, branch);
    if (record) genericTickets.push(record);
  }
  const dashboardTickets = await parseDashboardLedger(repositoryUrl, branch);
  const ticketMap = new Map(genericTickets.map((ticket) => [ticket.id, ticket]));
  for (const ticket of dashboardTickets) ticketMap.set(ticket.id, ticket);
  for (const ticket of serviceTickets) ticketMap.set(ticket.id, ticket);
  const tickets = sortTickets([...ticketMap.values()]);

  const planEntries = await readDirectory(plansDirectory);
  const planDirectoryNames = planEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const filesByDirectory = new Map();
  for (const directory of planDirectoryNames) {
    const prefix = `${join(plansDirectory, directory)}${process.platform === "win32" ? "\\" : "/"}`;
    const names = new Set(
      planFiles.filter((path) => path.startsWith(prefix)).map((path) => path.split(/[\\/]/).pop()),
    );
    filesByDirectory.set(directory, names);
  }
  const plans = await parsePlans(
    planDirectoryNames,
    filesByDirectory,
    tickets,
    repositoryUrl,
    branch,
  );

  const changeEntries = await readDirectory(changesDirectory);
  const changeDirectories = changeEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const changes = await parseSpecChanges(changeDirectories, repositoryUrl, branch);

  const sources = [];
  sources.push({ label: "Tracker", path: `github / repo ${repo}` });
  if (dashboardTickets.length > 0) {
    sources.push({
      label: "Status ledger",
      path: relativePath(join(docsDirectory, "dashboard-plan/status.md")),
    });
  }
  if (planTicketFiles.length > 0) {
    sources.push({
      label: "Plan tickets",
      path: `${relativePath(plansDirectory)}/**/tickets/*.md`,
    });
  }
  if (changes.length > 0) {
    sources.push({
      label: "Change proposals",
      path: `${relativePath(changesDirectory)}/*/`,
    });
  }
  for (const service of serviceStatuses) {
    sources.push({
      label: service.label,
      path: service.sourcePath || `${service.type} service`,
    });
  }

  const data = {
    meta: {
      projectName,
      theme: config.theme,
      services: serviceStatuses,
      snapshot,
      branch,
      commit,
      repo,
      repositoryUrl,
      docsRoot: relativePath(docsDirectory),
      sources,
      ticketCount: tickets.length,
      planCount: plans.length,
      changeCount: changes.length,
    },
    tickets,
    plans,
    changes,
    workItems: tracker.workItems,
    maps: tracker.maps,
    sessions,
  };
  await writeFile(
    outputPath,
    `import type { OverviewData } from './types';\n\n// Generated by pnpm workbench sync. Do not edit by hand.\nexport const overviewData = ${JSON.stringify(data, null, 2)} satisfies OverviewData;\n`,
  );
  console.log(
    `Synced ${tickets.length} tickets, ${plans.length} plans, ${changes.length} OpenSpec changes, and ${serviceTickets.length} service tasks.` +
      (sessions.enabled
        ? ` Sessions: ${sessions.sessions.length} tracked (${sessions.perModel.length} models).`
        : " Sessions sync disabled."),
  );
  if (tracker.warnings.length > 0) {
    console.log(`Tracker warnings (${tracker.warnings.length}):`);
    for (const warning of tracker.warnings) console.log(`  - ${warning}`);
  } else {
    console.log(
      `Tracker: ${tracker.workItems.length} work items, ${tracker.maps.length} maps, no warnings.`,
    );
  }
};

await main();
