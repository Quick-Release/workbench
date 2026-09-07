import type { SessionUsageRecord } from "../types";

// The Session handoffs lens (issue #65) renders exactly what the session
// database can attribute: parent/child trees joined over the recorded
// `parent` links, per-session skill tool calls riding on the session rows.
// A /clear shows up only as a new session row and compaction is not
// distinguishable — inference never renders as recorded fact, so anything
// the rows cannot prove becomes a caveat, never a guess.

export type SessionHandoffCaveat = {
  kind: "parent-outside-view" | "parent-link-cycle";
  message: string;
};

export type SessionHandoffNode = {
  session: SessionUsageRecord;
  children: SessionHandoffNode[];
  caveats: SessionHandoffCaveat[];
};

export type SessionHandoffForest = {
  roots: SessionHandoffNode[];
  // One handoff boundary per recorded parent link, whether or not the join
  // can honor it: an out-of-view parent and a cycle link are still recorded
  // handoffs, so dropping them would understate the boundary count.
  boundaries: number;
};

const bySession = (left: SessionUsageRecord, right: SessionUsageRecord) =>
  left.started.localeCompare(right.started) || left.id.localeCompare(right.id);

const CYCLE_MESSAGE =
  "Parent links close a cycle — the tree breaks it at the earliest session in the cycle; every recorded boundary still counts.";

// Follows parent links from each session; when the walk returns to its start,
// the whole walked path is the cycle. Members already grouped are skipped, so
// each cycle is reported once and the result is input-order independent.
const detectCycles = (
  sessions: readonly SessionUsageRecord[],
  byId: ReadonlyMap<string, SessionUsageRecord>,
): SessionUsageRecord[][] => {
  const grouped = new Set<string>();
  const cycles: SessionUsageRecord[][] = [];
  for (const start of sessions) {
    if (grouped.has(start.id)) continue;
    const path: SessionUsageRecord[] = [];
    const onPath = new Set<string>();
    let current: string = start.id;
    while (current !== "" && !onPath.has(current)) {
      const row = byId.get(current)!;
      path.push(row);
      onPath.add(current);
      current = row.parent !== "" && byId.has(row.parent) ? row.parent : "";
    }
    if (current === start.id) {
      cycles.push(path);
      for (const member of path) grouped.add(member.id);
    }
  }
  return cycles;
};

export const sessionHandoffs = (sessions: readonly SessionUsageRecord[]): SessionHandoffForest => {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const cycles = detectCycles(sessions, byId);
  const cycleMembers = new Set(cycles.flat().map((session) => session.id));
  // The tree breaks each cycle at its earliest member: that member renders as
  // a root, its own parent link stays recorded but unhonored, and the rest of
  // the cycle nests below it — every session renders exactly once.
  const cycleRoots = new Set(cycles.map((members) => [...members].sort(bySession)[0].id));

  const childrenOf = new Map<string, SessionUsageRecord[]>();
  for (const session of sessions) {
    if (session.parent === "" || !byId.has(session.parent)) continue;
    if (cycleRoots.has(session.id)) continue;
    const children = childrenOf.get(session.parent) || [];
    children.push(session);
    childrenOf.set(session.parent, children);
  }

  const attached = new Set<string>();
  for (const children of childrenOf.values()) {
    for (const session of children) attached.add(session.id);
  }

  const caveatsFor = (session: SessionUsageRecord): SessionHandoffCaveat[] => {
    const caveats: SessionHandoffCaveat[] = [];
    if (session.parent !== "" && !byId.has(session.parent))
      caveats.push({
        kind: "parent-outside-view",
        message: `Parent session "${session.parent}" is not in this view — the handoff was recorded, but its parent side is unattributed.`,
      });
    if (cycleMembers.has(session.id))
      caveats.push({ kind: "parent-link-cycle", message: CYCLE_MESSAGE });
    return caveats;
  };

  const nodeFor = (session: SessionUsageRecord): SessionHandoffNode => ({
    session,
    children: (childrenOf.get(session.id) || []).sort(bySession).map(nodeFor),
    caveats: caveatsFor(session),
  });

  const roots = [...sessions].filter((session) => !attached.has(session.id)).sort(bySession);

  return {
    roots: roots.map(nodeFor),
    boundaries: sessions.filter((session) => session.parent !== "").length,
  };
};
