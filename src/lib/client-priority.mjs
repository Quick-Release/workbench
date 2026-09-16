// Plain ESM so the installed CLI's raw-Node sync can import it from
// node_modules, where Node refuses to type-strip TypeScript (GH-195); types
// live in the sibling .d.mts.
import { workItemIdNumber } from "./work-item-id.mjs";

// The canonical client-label vocabulary, runtime home of the value this
// module and src/types.ts share: the sync's scripts run under raw Node, so
// the const lives here and types.ts re-exports it — one source, never
// re-declared (the tracker's client discovery walks GitHub by these labels).
export const clientTicketKinds = ["client-bug", "client-feedback"];
export const [clientBugKind, clientFeedbackKind] = clientTicketKinds;

// GH-136: the client-first work policy's pure half — one module the tracker,
// the seam, and the UI all read, so classification, ordering, and the
// feature-start gate can never drift apart. Client origin is *declared* by
// label, never inferred from author identity, title wording, or an LLM.
//
// The policy keeps two results apart: client *attention* is every open client
// ticket regardless of executability; *allowed actions* pass only what the
// ticket's triage state, blocker edges, and ownership justify. The bug gate
// is the enforced half of the second result (ADR 0012).

// Exact-name match after light normalization — never a substring:
// "client-bugs", "verify-client-bug", and "client bug triage" do not
// classify. Whitespace/underscore/case variants of the canonical names do.
const normalizeLabelName = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

export const classifyClientTicket = (labels) => {
  if (!labels) return null;
  const normalized = new Set(labels.map(normalizeLabelName));
  if (normalized.has(clientBugKind)) return "client-bug";
  if (normalized.has(clientFeedbackKind)) return "client-feedback";
  return null;
};

// The effective kind. A `client-feedback` issue categorized `bug` receives
// bug-tier treatment: inconsistent tagging must not open a gate bypass by
// dressing a client defect up as feedback (or vice versa).
export const clientKindFor = (record) => {
  const kind = classifyClientTicket(record.labels);
  if (kind === "client-feedback" && record.category === "bug") return "client-bug";
  return kind;
};

// 0 = client bug, 1 = client feedback, 2 = internal work.
export const clientTierFor = (record) => {
  const kind = clientKindFor(record);
  if (kind === "client-bug") return 0;
  return kind === "client-feedback" ? 1 : 2;
};

const issueNumberOf = (record) => workItemIdNumber(record.id);

// Tier order first, deterministic issue-number fallback; a stable sort in the
// caller keeps the existing readiness/map-order rules inside each tier.
export const compareByClientTier = (left, right) => {
  const tier = clientTierFor(left) - clientTierFor(right);
  if (tier !== 0) return tier;
  return issueNumberOf(left) - issueNumberOf(right);
};

// Client attention: every open client ticket, whether or not anything can be
// done about it right now. Deferred, untriaged, wontfix, and waiting tickets
// stay here — attention is not executability.
export const clientAttention = (workItems) => {
  const open = workItems.filter((record) => record.state === "open");
  return {
    bugs: open.filter((record) => clientKindFor(record) === "client-bug").sort(compareByClientTier),
    feedback: open
      .filter((record) => clientKindFor(record) === "client-feedback")
      .sort(compareByClientTier),
  };
};

export const openClientBugs = (workItems) =>
  workItems
    .filter((record) => record.state === "open" && clientKindFor(record) === "client-bug")
    .map((record) => ({ id: record.id, title: record.title, url: record.url }))
    .sort((left, right) => issueNumberOf(left) - issueNumberOf(right));

// The row's waiting/blocked explanation, computed from blocker edges and the
// record's own state — never a stored status. Blocked outranks parked, which
// outranks the explicit waiting states; an actionable ticket explains nothing
// and renders no excuse (GH-136).
export const clientWaitingReason = (record, workItems, blockerEdges) => {
  const stateById = new Map(workItems.map((item) => [item.id, item]));
  const openBlockers = blockerEdges
    .filter((edge) => edge.blockedId === record.id)
    .map((edge) => edge.blockerId)
    .filter((id) => stateById.get(id)?.state === "open")
    .sort((left, right) => issueNumberOf({ id: left }) - issueNumberOf({ id: right }));
  if (openBlockers.length > 0) return `blocked by ${openBlockers.join(", ")}`;
  if (record.deferred) return "parked (deferred)";
  switch (record.triageState) {
    case "needs-info":
      return "waiting on information";
    case "ready-for-human":
      return "waiting on a human";
    case "wontfix":
      return "refused (wontfix)";
    case "needs-triage":
    case "unlabeled":
      return "awaiting triage";
    default:
      return null;
  }
};

const allowed = (blockingBugs) => ({
  allowed: true,
  reason: null,
  blockingBugs,
  explanation: "",
});

// The bug gate (ADR 0012): while any open client bug exists, unrelated
// feature implementation cannot start. Fail-closed like the frontier (ADR
// 0008) — a target that cannot be affirmatively classified never silently
// passes, and unverified coverage never reads as "no client bugs".
export const evaluateClientGate = ({
  target,
  coverageComplete,
  openClientBugs: bugs = [],
  prerequisiteOfOpenClientBugs = [],
}) => {
  const names = (list) => list.map((bug) => `${bug.id} "${bug.title}"`).join(", ");
  if (!target || target.state !== "open")
    return {
      allowed: false,
      reason: "target_not_open",
      blockingBugs: bugs,
      explanation: "Target issue is not open; there is nothing to start.",
    };
  // Wayfinder decision tickets resolve into decisions, not build slices —
  // planning stays available under the gate.
  if (target.kind !== null) return allowed(bugs);
  // Remediation of an open client ticket is always the point.
  if (classifyClientTicket(target.labels) !== null) return allowed(bugs);
  // A validated prerequisite of an open client bug ("unblocks client bug #N")
  // is justified work; dependency and readiness checks stay with the caller.
  if (prerequisiteOfOpenClientBugs.length > 0) return allowed(bugs);
  // An internal bug fix is not feature implementation — allow it even when
  // client coverage is unverified: the gate pauses features, not remediation.
  if (target.category === "bug" && classifyClientTicket(target.labels) === null)
    return allowed(bugs);
  if (!coverageComplete)
    return {
      allowed: false,
      reason: "client_priority_unverified",
      blockingBugs: bugs,
      explanation:
        "Client-ticket coverage is incomplete or stale, so the gate cannot verify there is no open client bug; re-sync and retry.",
    };
  if (bugs.length > 0)
    return {
      allowed: false,
      reason: "client_bugs_open",
      blockingBugs: bugs,
      explanation: `${bugs.length === 1 ? "1 open client bug" : `${bugs.length} open client bugs`} — ${names(bugs)}. New feature starts are paused until ${bugs.length === 1 ? "it closes" : "they close"}.`,
    };
  return allowed(bugs);
};
