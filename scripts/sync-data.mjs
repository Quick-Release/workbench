import { execFileSync } from "node:child_process";
import { loadWorkbenchConfig } from "./config.mjs";
import { SELF_REPOSITORY_URL, servicesForSource } from "./self-defaults.mjs";
import { fetchConfiguredServices } from "./services/index.mjs";
import {
  collectSessionUsage,
  resolveSessionsDatabasePath,
  sessionUsageDisabled,
} from "./sessions.mjs";
import { collectSkillsCatalog } from "./skills-catalog.mjs";
import { demoSourceRoot, resolveSourceRoot } from "./source-root.mjs";
import { lineEdgesForTicketFile, mergeBlockerEdges } from "./tracker/edges.mjs";
import {
  collectAdrDecisions,
  collectResearchArtifacts,
  sortDecisions,
} from "./tracker/decisions.mjs";
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
const outputPath = join(appDirectory, "src/data.generated.ts");

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

// ADR 0008: local ticket files stay an edge-declaring surface — a
// `Blocked by:` line in `docs/plans/**/tickets/*.md` names its gate in the
// file's own namespace. Only each file's id, text, and path are collected
// (the path is the edge's sourceRef); the file's status is never read.
const ticketIdFrom = (text, filename) => {
  const headingMatch = text.match(/^#\s+([A-Z0-9][A-Z0-9-]*-\d+)\b/m);
  if (headingMatch) return headingMatch[1];
  const filenameMatch = filename.match(/^([A-Z0-9][A-Z0-9-]*-\d+)/i);
  return filenameMatch ? filenameMatch[1].toUpperCase() : "";
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

// Last-good skills data: the committed generated snapshot from the previous
// sync, used when the upstream catalog fetch fails (ADR 0006 fail-open chain).
const previousGeneratedData = async () => {
  const text = await readText(outputPath);
  const marker = "overviewData = ";
  const markerEnd = text.indexOf(marker);
  const end = text.lastIndexOf("satisfies");
  if (markerEnd === -1 || end === -1) return null;
  const start = markerEnd + marker.length;
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end));
  } catch {
    return null;
  }
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
  const { statuses: serviceStatuses } = await fetchConfiguredServices(
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

  // ADR 0009: decisions and artifacts collect at sync. The tracker-sourced
  // half (resolutions, spec bundles) rides collectTrackerState; the two file
  // walks are local conventions that fail soft to empty arrays on host repos
  // lacking them.
  const adrCollection = await collectAdrDecisions({
    directory: join(docsDirectory, "adr"),
  });
  const researchCollection = await collectResearchArtifacts({
    directory: join(docsDirectory, "research"),
    rootDirectory,
  });
  const decisions = sortDecisions([...tracker.decisions, ...adrCollection.decisions]);
  const artifacts = researchCollection.artifacts;

  const previous = (await previousGeneratedData()) ?? { skills: [] };
  const skillsCatalog = await collectSkillsCatalog({
    rootDirectory,
    lastGood: Array.isArray(previous.skills) ? previous.skills : [],
  });

  const ticketFileTexts = [];
  for (const path of (await walk(plansDirectory)).filter((path) => path.endsWith(".md"))) {
    if (!relativePath(path).includes("/tickets/")) continue;
    const text = await readText(path);
    if (!text) continue;
    const id = ticketIdFrom(text, path.split(/[\\/]/).pop() || "");
    if (!id) continue;
    ticketFileTexts.push({ id, text, sourcePath: relativePath(path) });
  }

  // ADR 0008: one flat top-level blockerEdges list. Repo-level native
  // precedence was already applied tracker-side to the two tracker syntaxes;
  // local ticket-file lines are a separate declaring surface it never gates
  // (a file's own id is never a tracker id), so the final merge runs with
  // native precedence off and unions the two.
  const blockerEdges = mergeBlockerEdges({
    nativeEdges: tracker.blockerEdges,
    nativeAvailable: false,
    lineEdges: ticketFileTexts.flatMap(({ id, text, sourcePath }) =>
      lineEdgesForTicketFile({ id, text, sourcePath }),
    ),
    knownIds: new Set([
      ...tracker.workItems.map((item) => item.id),
      ...ticketFileTexts.map((file) => file.id),
    ]),
  });
  // Tracker-side hygiene re-reports over the combined list (cross-source
  // cycles and dangling refs now resolved against ledger ids too); the
  // channel prints each distinct message once.
  const trackerWarnings = [
    ...new Set([...tracker.warnings, ...blockerEdges.warnings, ...adrCollection.warnings]),
  ];

  const sources = [];
  sources.push({ label: "Tracker", path: `github / repo ${repo}` });
  // ADR 0009: the decision sources name themselves even when a host repo
  // lacks the convention — the empty entry is the honest report.
  if (decisions.length > 0 || adrCollection.exists) {
    sources.push({ label: "Decisions", path: `${relativePath(docsDirectory)}/adr` });
  }
  if (artifacts.length > 0 || researchCollection.exists) {
    sources.push({ label: "Research notes", path: `${relativePath(docsDirectory)}/research` });
  }
  for (const service of serviceStatuses) {
    sources.push({
      label: service.label,
      path: service.sourcePath || `${service.type} service`,
    });
  }
  sources.push(
    skillsCatalog.degraded
      ? { label: "Skills catalog", path: "curated fallback (upstream unreachable)" }
      : { label: "Skills catalog", path: "mattpocock/skills" },
  );

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
    },
    workItems: tracker.workItems,
    maps: tracker.maps,
    blockerEdges: blockerEdges.edges,
    decisions,
    artifacts,
    pullRequests: tracker.pullRequests,
    skills: skillsCatalog.skills,
    skillInstalls: skillsCatalog.installedIds,
    sessions,
  };
  await writeFile(
    outputPath,
    `import type { OverviewData } from './types';\n\n// Generated by pnpm workbench sync. Do not edit by hand.\nexport const overviewData = ${JSON.stringify(data, null, 2)} satisfies OverviewData;\n`,
  );
  console.log(
    `Synced ${tracker.workItems.length} work items, ${tracker.maps.length} maps, ${blockerEdges.edges.length} blocker edges, and ${skillsCatalog.skills.length} catalog skills.` +
      (skillsCatalog.degraded ? " Skills catalog fell back to curated data." : "") +
      (sessions.enabled
        ? ` Sessions: ${sessions.sessions.length} tracked (${sessions.perModel.length} models).`
        : " Sessions sync disabled.") +
      ` Decisions: ${decisions.length} (${artifacts.length} artifacts). ${tracker.pullRequests.length} open pull requests.`,
  );
  if (trackerWarnings.length > 0) {
    console.log(`Tracker warnings (${trackerWarnings.length}):`);
    for (const warning of trackerWarnings) console.log(`  - ${warning}`);
  } else {
    console.log(
      `Tracker: ${tracker.workItems.length} work items, ${tracker.maps.length} maps, no warnings.`,
    );
  }
};

await main();
