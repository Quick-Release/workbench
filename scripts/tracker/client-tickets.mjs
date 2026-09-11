import { fetchIssuesByLabel } from "./issues.mjs";
import { clientBugKind, clientFeedbackKind } from "../../src/lib/client-priority.ts";

export const CLIENT_TICKET_LABELS = [clientBugKind, clientFeedbackKind];

// One bounded client pass (GH-136): a paginated, label-filtered read per
// client label — the OR of the two, unioned and deduped by number — with
// explicit coverage: a capped or failed read is unknown client state, never
// "no client tickets". Open discovery (state "open") feeds the snapshot; the
// closed lens reads closed history sorted by last update so the page bound
// keeps the most recently active tickets.
export const collectClientTickets = async ({
  repo,
  token,
  apiBase,
  fetchImpl,
  maxPages,
  state = "open",
  sort,
  direction = "desc",
}) => {
  const issues = new Map();
  const reasons = [];
  const warnings = [];
  const checkedAt = new Date().toISOString();
  let complete = true;
  for (const label of CLIENT_TICKET_LABELS) {
    const pass = await fetchIssuesByLabel({
      repo,
      token,
      apiBase,
      fetchImpl,
      label,
      state,
      sort,
      direction,
      maxPages,
    });
    warnings.push(...pass.warnings.map((warning) => `tracker: client discovery: ${warning}`));
    for (const issue of pass.issues) issues.set(issue.number, issue);
    if (pass.capped) {
      complete = false;
      reasons.push(`page-cap:${label}`);
    }
    if (pass.failed) {
      complete = false;
      reasons.push(`read-failed:${label}`);
    }
  }
  return {
    issues: [...issues.values()],
    coverage: { labels: CLIENT_TICKET_LABELS, checkedAt, complete, reasons },
    warnings,
  };
};
