import { execFileSync } from "node:child_process";

// Highlights candidates (ticket #17): the read path for Content sourcing's
// first step. Sync's git access extends from metadata-only to reading the
// host repo's recent commit log with bodies — no network, no tracker calls.
// The v1 heuristic: a candidate message has a body beyond the subject and
// references a ticket or issue, capped to the most recent 30. This is a
// candidate list only — nothing leaves the machine until an explicit
// Submission picks one.

const CANDIDATE_CAP = 30;
const SCAN_LIMIT = 1000;

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
const LOG_FORMAT = `--pretty=format:%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%B${RECORD_SEPARATOR}`;

// Ticket/issue references in the wild here: "#11" and "(issue 32)" are
// both conventions this repo's log actually uses. Either form normalizes
// to the "#NN" ticket reference a candidate carries.
const TICKET_PATTERN = /#\d+|\bissues? #?(\d+)\b/i;

// The v1 heuristic over one commit's message. Null when the message is
// subject-only, is a merge commit (its "body" is the merged PR title, not
// a Developer's message), or carries no ticket/issue reference.
export function candidateFromCommit({ sha, author, date, message }) {
  const [subjectLine, ...bodyLines] = message.split("\n");
  if (subjectLine.startsWith("Merge ")) return null;
  const body = bodyLines.join("\n").trim();
  if (body.length === 0) return null;
  const match = TICKET_PATTERN.exec(message);
  if (!match) return null;
  const ticketRef = match[0].startsWith("#") ? match[0] : `#${match[1]}`;
  return {
    sha,
    subject: subjectLine.trim(),
    body,
    author,
    date,
    ticketRef,
  };
}

// Folds a `git log` render (records separated by \x1e, newest first) into
// at most `cap` candidates — the most recent ones win.
export function candidatesFromLog(logOutput, cap = CANDIDATE_CAP) {
  const candidates = [];
  for (const record of logOutput.split(RECORD_SEPARATOR)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [sha, author, date, message = ""] = trimmed.split(FIELD_SEPARATOR);
    const candidate = candidateFromCommit({ sha, author, date, message });
    if (!candidate) continue;
    candidates.push(candidate);
    if (candidates.length >= cap) break;
  }
  return candidates;
}

// Reads the host repo's recent log through an injectable runner (the sync
// pipeline passes the real git runner; tests pass a canned one).
export async function collectCommitCandidates({
  rootDirectory,
  run = defaultRunner(rootDirectory),
  cap = CANDIDATE_CAP,
  limit = SCAN_LIMIT,
}) {
  const output = await run(["log", `-${limit}`, LOG_FORMAT]);
  return candidatesFromLog(output, cap);
}

function defaultRunner(rootDirectory) {
  // Fail soft per ADR 0009's collect-at-sync posture: a root without git
  // history (sync's fallback directory) yields no candidates instead of
  // crashing the whole sync.
  return async (args) => {
    try {
      return execFileSync("git", ["-C", rootDirectory, ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return "";
    }
  };
}
