import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  apiBaseFrom,
  fetchIssue,
  fetchMapIssues,
  fetchOpenIssues,
  fetchSubIssues,
} from "./issues.mjs";
import { deriveWorkItem, loadWorkflowVocabulary } from "./labels.mjs";

const execFileAsync = promisify(execFile);

// The gh CLI is this tracker's canonical client, so an authenticated `gh`
// login can stand in for exporting the token environment variable.
const tokenFromGhCli = async () => {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim();
  } catch {
    return "";
  }
};

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_ISSUE_READS = 250;

// ADR 0008: the host repo's tracker state collected as first-class records —
// work items for every issue the targeted reads reach, map membership (never
// edges) for map-labelled issues — under page caps, degrading fail-closed
// with warnings into the sync message. Sync never fails on tracker trouble.
export const collectTrackerState = async ({
  repo,
  env = process.env,
  fetchImpl = globalThis.fetch,
  ghToken = tokenFromGhCli,
  apiBaseUrl,
  tokenEnv = "GITHUB_TOKEN",
  maxPages = 10,
  vocabulary,
  vocabularyPath = "",
}) => {
  const empty = { workItems: [], maps: [], warnings: [] };
  if (!REPO_PATTERN.test(repo ?? ""))
    return {
      ...empty,
      warnings: [
        `tracker: repository "${repo ?? ""}" is not in owner/name format; tracker state not collected`,
      ],
    };

  const fromEnv = typeof env[tokenEnv] === "string" ? env[tokenEnv].trim() : "";
  const token = fromEnv || (await ghToken());
  if (!token)
    return {
      ...empty,
      warnings: [
        `tracker: missing ${tokenEnv} (set it, or authenticate the gh CLI); tracker state not collected`,
      ],
    };

  const apiBase = apiBaseFrom(apiBaseUrl);
  const warnings = [];
  let phaseVocabulary = vocabulary;
  if (!phaseVocabulary) {
    const loaded = await loadWorkflowVocabulary(vocabularyPath);
    phaseVocabulary = loaded.vocabulary;
    warnings.push(...loaded.warnings);
  }
  const sweep = await fetchOpenIssues({ repo, token, apiBase, fetchImpl, maxPages });
  warnings.push(...sweep.warnings);
  const mapIssues = await fetchMapIssues({ repo, token, apiBase, fetchImpl, maxPages });
  warnings.push(...mapIssues.warnings);

  const workItems = [];
  const recordsById = new Map();
  const collectRecords = (issues) => {
    for (const result of issues) {
      const id = `GH-${result.number}`;
      if (recordsById.has(id)) continue;
      const { record, warnings: itemWarnings } = deriveWorkItem(result, phaseVocabulary);
      workItems.push(record);
      recordsById.set(id, record);
      warnings.push(...itemWarnings);
    }
  };

  const knownNumbers = new Set(sweep.issues.map((entry) => entry.number));
  collectRecords(sweep.issues);
  collectRecords(mapIssues.issues);

  const maps = [];
  let targetedReads = 0;
  let cappedReads = false;
  for (const mapIssue of mapIssues.issues) {
    const record = recordsById.get(`GH-${mapIssue.number}`);
    const { issues: members, warnings: memberWarnings } = await fetchSubIssues({
      repo,
      token,
      apiBase,
      issueNumber: mapIssue.number,
      fetchImpl,
      maxPages,
    });
    warnings.push(...memberWarnings.map((warning) => `${record.id}: ${warning}`));
    const ticketIds = [];
    let cappedHere = 0;
    for (const member of members) {
      ticketIds.push(`GH-${member.number}`);
      if (knownNumbers.has(member.number)) continue;
      if (targetedReads >= MAX_ISSUE_READS) {
        cappedHere += 1;
        continue;
      }
      targetedReads += 1;
      const { issue: closedIssue, warnings: readWarnings } = await fetchIssue({
        repo,
        token,
        apiBase,
        issueNumber: member.number,
        fetchImpl,
      });
      warnings.push(...readWarnings.map((warning) => `${record.id}: ${warning}`));
      if (closedIssue) collectRecords([closedIssue]);
    }
    if (cappedHere > 0) {
      cappedReads = true;
      warnings.push(
        `${record.id}: targeted reads stopped at the ${MAX_ISSUE_READS} cap; ${cappedHere} member records not collected`,
      );
    }
    maps.push({
      mapId: record.id,
      title: record.title,
      url: record.url,
      ticketIds,
    });
  }
  if (cappedReads)
    warnings.push(
      "tracker: some map members were not read; their work-item records may be missing",
    );

  const byNumberAsc = (left, right) => Number(left.id.slice(3)) - Number(right.id.slice(3));
  workItems.sort(byNumberAsc);
  return { workItems, maps, warnings };
};
