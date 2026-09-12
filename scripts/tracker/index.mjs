import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  apiBaseFrom,
  fetchBlockedBy,
  fetchIssue,
  fetchIssueComments,
  fetchIssueEvents,
  fetchIssuesByLabel,
  fetchMapIssues,
  fetchOpenIssues,
  fetchSubIssues,
} from "./issues.mjs";
import { phaseClockable, phaseSinceFromEvents } from "../../src/lib/phase-clock.ts";
import { workItemIdNumber } from "../../src/lib/work-item-id.ts";
import { CLIENT_TICKET_LABELS, collectClientTickets } from "./client-tickets.mjs";
import { lineEdgesForBody, mergeBlockerEdges } from "./edges.mjs";
import { resolutionDecisionFromIssue, sortDecisions, specDecisionFromIssue } from "./decisions.mjs";
import { fetchOpenPullRequests } from "./pulls.mjs";
import {
  DEFAULT_DECISION_PLACEMENT,
  deriveWorkItem,
  loadDecisionPlacement,
  loadWorkflowVocabulary,
} from "./labels.mjs";

const execFileAsync = promisify(execFile);

// The gh CLI is this tracker's canonical client, so an authenticated `gh`
// login can stand in for exporting the token environment variable.
export const tokenFromGhCli = async () => {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim();
  } catch {
    return "";
  }
};

// The tracker credential chain, shared by every raw GitHub read: an explicit
// token environment variable wins, and an authenticated `gh` login stands in.
export const resolveGhToken = async ({
  env = process.env,
  ghToken = tokenFromGhCli,
  tokenEnv = "GITHUB_TOKEN",
}) => {
  const fromEnv = typeof env[tokenEnv] === "string" ? env[tokenEnv].trim() : "";
  return fromEnv || (await ghToken());
};

const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_ISSUE_READS = 250;
// GH-149: the label-event reads carry their own budget, independent of the
// targeted-issue and resolution budgets — a clock degrades before any of
// those ever do.
const MAX_EVENT_READS = 250;

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
  // GH-149: the previous snapshot's clocks, keyed by record id — an entry
  // whose `updatedAt` still matches the issue's costs zero events calls, and
  // carries its `phaseSince` over untouched.
  phaseClocks = new Map(),
}) => {
  // Every record family the sync merge iterates rides even the degraded
  // returns — a missing decisions array crashes the sort, not a warning.
  // Client coverage degrades with them: uncollected tracker state is unknown
  // client state, never "no client tickets" (GH-136).
  const empty = {
    workItems: [],
    maps: [],
    blockerEdges: [],
    decisions: [],
    pullRequests: [],
    // Ticket #146: the board's shipped page (never collected here) and the
    // canonical placement table (the doc home was never read).
    recentlyShipped: [],
    decisionPlacement: DEFAULT_DECISION_PLACEMENT,
    clientCoverage: {
      labels: CLIENT_TICKET_LABELS,
      checkedAt: new Date().toISOString(),
      complete: false,
      reasons: ["tracker-unavailable"],
    },
    warnings: [],
  };
  if (!REPO_PATTERN.test(repo ?? ""))
    return {
      ...empty,
      warnings: [
        `tracker: repository "${repo ?? ""}" is not in owner/name format; tracker state not collected`,
      ],
    };

  const token = await resolveGhToken({ env, ghToken, tokenEnv });
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
  // Validation-only until the board consumes the placement: every sync keeps
  // the doc home honest, dropping malformed rows into the warnings channel.
  // The parsed table also rides the snapshot — the board reads the doc home
  // through it instead of hardcoding a second copy (ticket #146).
  const placement = await loadDecisionPlacement(vocabularyPath);
  warnings.push(...placement.warnings);
  const sweep = await fetchOpenIssues({ repo, token, apiBase, fetchImpl, maxPages });
  warnings.push(...sweep.warnings);
  const mapIssues = await fetchMapIssues({ repo, token, apiBase, fetchImpl, maxPages });
  warnings.push(...mapIssues.warnings);
  const openPulls = await fetchOpenPullRequests({ repo, token, apiBase, fetchImpl, maxPages });
  warnings.push(...openPulls.warnings);

  const workItems = [];
  const recordsById = new Map();
  // ADR 0009: every issue body the adapter already holds is a spec-bundle
  // candidate; the section's presence declares the record, nothing re-read.
  const issuesByNumber = new Map();
  const collectRecords = (issues) => {
    for (const result of issues) {
      const id = `GH-${result.number}`;
      if (recordsById.has(id)) continue;
      issuesByNumber.set(result.number, result);
      const { record, warnings: itemWarnings } = deriveWorkItem(result, phaseVocabulary);
      workItems.push(record);
      recordsById.set(id, record);
      warnings.push(...itemWarnings);
    }
  };

  const knownNumbers = new Set(sweep.issues.map((entry) => entry.number));
  collectRecords(sweep.issues);
  collectRecords(mapIssues.issues);

  // GH-136: client tickets are discovered by bounded, label-specific paginated
  // reads — the OR of the two client labels, so an issue wearing both is found
  // by either query — unioned into the records the sweep and maps already
  // hold. The pass reports explicit coverage: a capped or failed read is
  // unknown client state, never "no client tickets".
  const clientPass = await collectClientTickets({ repo, token, apiBase, fetchImpl, maxPages });
  warnings.push(...clientPass.warnings);
  collectRecords(clientPass.issues);
  const clientCoverage = clientPass.coverage;

  const maps = [];
  // ADR 0009: resolution records ride the same membership enumeration —
  // closed children get one targeted comments read (never a sweep). The
  // resolution reads carry their own cap so they never deplete the
  // work-item read budget the work items and blocker edges depend on.
  const resolutions = [];
  let targetedReads = 0;
  let resolutionReads = 0;
  let cappedReads = false;
  let cappedResolutions = 0;
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
    let cappedResolutionsHere = 0;
    for (const member of members) {
      ticketIds.push(`GH-${member.number}`);
      if (!issuesByNumber.has(member.number)) issuesByNumber.set(member.number, member);
      if (member.state === "closed") {
        if (resolutionReads >= MAX_ISSUE_READS) {
          cappedResolutionsHere += 1;
        } else {
          resolutionReads += 1;
          const { comments, warnings: commentWarnings } = await fetchIssueComments({
            repo,
            token,
            apiBase,
            issueNumber: member.number,
            fetchImpl,
            maxPages,
          });
          warnings.push(...commentWarnings.map((warning) => `${record.id}: ${warning}`));
          const resolution = resolutionDecisionFromIssue({ issue: member, comments });
          if (resolution) resolutions.push(resolution);
        }
      }
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
    if (cappedResolutionsHere > 0) {
      cappedReads = true;
      warnings.push(
        `${record.id}: targeted reads stopped at the ${MAX_ISSUE_READS} cap; ${cappedResolutionsHere} resolution comments not collected`,
      );
      cappedResolutions += cappedResolutionsHere;
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

  // ADR 0008: native blocked-by edges for issues whose dependency summary
  // declares blockers, targeted reads for blocker endpoints the sweep never
  // reached, and `Blocked by:` lines from open issue bodies as the second
  // syntax — merged with repo-level native precedence and markdown hygiene.
  const openIssues = [];
  const seenOpen = new Set();
  for (const entry of [...sweep.issues, ...mapIssues.issues]) {
    if (entry.state === "closed" || seenOpen.has(entry.number)) continue;
    seenOpen.add(entry.number);
    openIssues.push(entry);
  }

  const nativeEdges = [];
  const nativeAvailable = openIssues.some(
    (entry) => entry.issue_dependencies_summary !== undefined,
  );
  let cappedBlockers = 0;
  for (const entry of openIssues) {
    const summary = entry.issue_dependencies_summary;
    // `blocked_by` counts open blockers only; `total_blocked_by` includes
    // closed ones — the satisfied edges the blocker graph still renders.
    const declared = summary?.total_blocked_by ?? 0;
    if (declared <= 0) continue;
    const id = `GH-${entry.number}`;
    const { issues: blockers, warnings: listWarnings } = await fetchBlockedBy({
      repo,
      token,
      apiBase,
      issueNumber: entry.number,
      fetchImpl,
      maxPages,
    });
    warnings.push(...listWarnings.map((warning) => `${id}: ${warning}`));
    for (const blocker of blockers) {
      nativeEdges.push({
        blockedId: id,
        blockerId: `GH-${blocker.number}`,
        source: "github-native",
        sourceRef: entry.html_url ?? "",
      });
      if (recordsById.has(`GH-${blocker.number}`)) continue;
      if (targetedReads >= MAX_ISSUE_READS) {
        cappedBlockers += 1;
        continue;
      }
      targetedReads += 1;
      const { issue: blockerIssue, warnings: readWarnings } = await fetchIssue({
        repo,
        token,
        apiBase,
        issueNumber: blocker.number,
        fetchImpl,
      });
      warnings.push(...readWarnings.map((warning) => `${id}: ${warning}`));
      if (blockerIssue) collectRecords([blockerIssue]);
    }
  }
  if (cappedBlockers > 0)
    warnings.push(
      `tracker: targeted reads stopped at the ${MAX_ISSUE_READS} cap; ${cappedBlockers} blocker records not collected`,
    );

  const lineEdges = openIssues.flatMap((entry) =>
    lineEdgesForBody(entry.body ?? "", `GH-${entry.number}`, entry.html_url ?? ""),
  );
  const merged = mergeBlockerEdges({
    nativeEdges,
    nativeAvailable,
    lineEdges,
    knownIds: new Set(recordsById.keys()),
  });
  warnings.push(...merged.warnings);

  // ADR 0009: tracker-sourced decisions — one spec bundle per issue whose
  // body declares an Implementation-Decisions section, plus the resolution
  // records gathered off the maps above — sorted for the snapshot.
  const specBundles = [...issuesByNumber.values()].flatMap((issue) => {
    const bundle = specDecisionFromIssue(issue);
    return bundle ? [bundle] : [];
  });

  // Ticket #146: the shipped column's bounded page — closed issues wearing
  // the shipped label, one page most-recently-updated-first, never a
  // closed-history sweep. Ids the sweep, maps, client pass, and targeted
  // reads already hold stay out; the board merges this page with its work
  // items, so nothing renders twice and closed pages still satisfy gates.
  const shippedLabel =
    phaseVocabulary.find((entry) => entry.phase === "shipped")?.label ?? "workflow:shipped";
  const shippedPage = await fetchIssuesByLabel({
    repo,
    token,
    apiBase,
    fetchImpl,
    label: shippedLabel,
    state: "closed",
    sort: "updated",
    direction: "desc",
    maxPages: 1,
  });
  warnings.push(...shippedPage.warnings);
  const recentlyShipped = [];
  for (const shipped of shippedPage.issues) {
    if (recordsById.has(`GH-${shipped.number}`)) continue;
    const { record, warnings: itemWarnings } = deriveWorkItem(shipped, phaseVocabulary);
    recentlyShipped.push(record);
    recordsById.set(record.id, record);
    warnings.push(...itemWarnings);
  }
  const byNumber = (left, right) => Number(left.id.slice(3)) - Number(right.id.slice(3));
  const byNumberDesc = (left, right) => byNumber(right, left);
  recentlyShipped.sort(byNumberDesc);

  // GH-149: the time-in-phase clock. Each clockable record (a resolved phase,
  // and no decision-ticket kind — phaseClockable is the display rule's own
  // predicate) clocks from its label-event history — the latest `labeled`
  // event for the phase's label, so re-entry resets. An issue whose
  // `updatedAt` is unchanged reuses the previous sync's clock at zero events
  // cost; a failed or capped read leaves the clock null with a warning —
  // unknown, never zero time. The budget is the events walks' own, so clocks
  // degrade before any other family does.
  const labelForPhase = (phase) => phaseVocabulary.find((entry) => entry.phase === phase)?.label;
  let eventReads = 0;
  let cappedClocks = 0;
  for (const record of [...workItems, ...recentlyShipped]) {
    if (!phaseClockable(record)) continue;
    const label = labelForPhase(record.phase);
    if (!label) continue;
    const cached = phaseClocks.get(record.id);
    if (cached && record.updatedAt !== undefined && cached.updatedAt === record.updatedAt) {
      record.phaseSince = cached.phaseSince;
      continue;
    }
    if (eventReads >= MAX_EVENT_READS) {
      cappedClocks += 1;
      continue;
    }
    eventReads += 1;
    const {
      events,
      warnings: eventWarnings,
      capped,
      failed,
    } = await fetchIssueEvents({
      repo,
      token,
      apiBase,
      issueNumber: workItemIdNumber(record.id),
      fetchImpl,
      maxPages,
    });
    warnings.push(...eventWarnings.map((warning) => `${record.id}: ${warning}`));
    // An incomplete history (mid-walk failure included) never clocks: a
    // truncated prefix could name an older stay.
    if (capped || failed) continue;
    record.phaseSince = phaseSinceFromEvents(events, label) ?? undefined;
  }
  if (cappedClocks > 0)
    warnings.push(
      `tracker: event reads stopped at the ${MAX_EVENT_READS} cap; ${cappedClocks} phase clocks not collected`,
    );

  workItems.sort(byNumber);
  return {
    workItems,
    maps,
    blockerEdges: merged.edges,
    decisions: sortDecisions([...resolutions, ...specBundles]),
    pullRequests: [...openPulls.pulls].sort((left, right) => left.number - right.number),
    recentlyShipped,
    decisionPlacement: placement.placement,
    clientCoverage,
    warnings,
  };
};
