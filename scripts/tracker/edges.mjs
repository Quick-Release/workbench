// ADR 0008: blocker edges come from exactly two syntaxes — GitHub native
// blocked-by and the `Blocked by:` line grammar — native wins at the repo
// level for issue↔issue pairs, and sync performs the markdown hygiene. This
// module is the pure half: parsing, resolution, merge, and hygiene. It never
// reads and never throws; sync stitches it into the collector.

// The three key aliases name one relation; they dedupe to a single edge.
const BLOCKED_BY_LINE = /^\s*(?:[-*]\s*)?(?:Dependencies|Blocked by|Depends on)\s*:\s*(.+)$/gim;

const REF_PATTERN = /^(?:#?(\d+)|([A-Za-z][A-Za-z0-9]*)-(\d+))$/;

// One line's refs, in order, stopping at the first token that is not a ref —
// "Blocked by: #55 and #56 then prose" declares only #55.
const refsFromValue = (value, homeNamespace) => {
  const refs = [];
  for (const token of value.split(/[\s,]+/)) {
    const ref = token.match(REF_PATTERN);
    if (!ref) break;
    if (ref[1] !== undefined) refs.push(`${homeNamespace}-${ref[1]}`);
    else refs.push(`${ref[2].toLocaleUpperCase()}-${ref[3]}`);
  }
  return refs;
};

export const blockedByRefs = (text, homeNamespace = "GH") => {
  const refs = [];
  for (const match of String(text ?? "").matchAll(BLOCKED_BY_LINE)) {
    for (const ref of refsFromValue(match[1], homeNamespace)) {
      if (!refs.includes(ref)) refs.push(ref);
    }
  }
  return refs;
};

const lineEdge = (blockedId, blockerId, sourceRef) => ({
  blockedId,
  blockerId,
  source: "blocked-by-line",
  sourceRef,
});

// An issue body declares edges in the tracker's home namespace.
export const lineEdgesForBody = (body, blockedId, sourceRef, homeNamespace = "GH") =>
  blockedByRefs(body, homeNamespace).map((blockerId) => lineEdge(blockedId, blockerId, sourceRef));

// A local ticket file declares edges in its own id's namespace first;
// qualified refs (GH-47) reach across sources.
export const lineEdgesForTicketFile = ({ id, text, sourcePath }) => {
  const homeNamespace = id.includes("-") ? id.slice(0, id.indexOf("-")) : id;
  return blockedByRefs(text, homeNamespace).map((blockerId) => lineEdge(id, blockerId, sourcePath));
};

// Native precedence is repo-level: when the dependencies feature answers,
// native edges are authoritative for issue↔issue pairs and same-namespace
// lines are ignored — a UI-removed edge is not resurrected by a stale line —
// while lines remain the sole source where native is unavailable and for
// cross-source references native cannot express.
const TRACKER_NAMESPACE = "GH";
const isTrackerIssueId = (id) => {
  const match = id.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
  return match !== null && match[1].toLocaleUpperCase() === TRACKER_NAMESPACE;
};

const edgeKey = (edge) => `${edge.blockedId}::${edge.blockerId}`;

const numberSuffix = (id) => Number(id.slice(id.lastIndexOf("-") + 1)) || 0;

const compareIds = (left, right) =>
  numberSuffix(left) - numberSuffix(right) || left.localeCompare(right);

const compareEdges = (left, right) =>
  compareIds(left.blockedId, right.blockedId) ||
  compareIds(left.blockerId, right.blockerId) ||
  left.source.localeCompare(right.source);

export const mergeBlockerEdges = ({
  nativeEdges = [],
  nativeAvailable,
  lineEdges = [],
  knownIds,
}) => {
  const warnings = [];
  const edges = [];
  const seen = new Set();

  const survivingLines = nativeAvailable
    ? lineEdges.filter(
        (edge) => !(isTrackerIssueId(edge.blockedId) && isTrackerIssueId(edge.blockerId)),
      )
    : lineEdges;

  for (const edge of [...nativeEdges, ...survivingLines]) {
    if (edge.blockedId === edge.blockerId) {
      warnings.push(
        `blocker edge from ${edge.blockedId} to itself dropped (${edge.source} at ${edge.sourceRef})`,
      );
      continue;
    }
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }

  const dangling = new Set();
  for (const edge of edges) {
    for (const endpoint of [edge.blockedId, edge.blockerId]) {
      if (knownIds.has(endpoint) || dangling.has(endpoint)) continue;
      dangling.add(endpoint);
      warnings.push(
        `blocker edge references ${endpoint}, which no collected record covers; edge kept and fails closed (dangling)`,
      );
    }
  }

  warnings.push(...cycleWarnings(edges, knownIds));

  edges.sort(compareEdges);
  return { edges, warnings };
};

// Cycles surface in the sync message without auto-breaking: only edges whose
// endpoints are all collected can be traversed.
const cycleWarnings = (edges, knownIds) => {
  const traversable = edges.filter(
    (edge) => knownIds.has(edge.blockedId) && knownIds.has(edge.blockerId),
  );
  if (traversable.length === 0) return [];

  const blockersOf = new Map();
  for (const edge of traversable) {
    if (!blockersOf.has(edge.blockedId)) blockersOf.set(edge.blockedId, []);
    blockersOf.get(edge.blockedId).push(edge.blockerId);
  }

  // Tarjan's strongly-connected components; a component of more than one
  // node is a cycle.
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const warnings = [];
  let counter = 0;

  const strongConnect = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const blocker of blockersOf.get(node) ?? []) {
      if (!index.has(blocker)) {
        strongConnect(blocker);
        low.set(node, Math.min(low.get(node), low.get(blocker)));
      } else if (onStack.has(blocker)) {
        low.set(node, Math.min(low.get(node), index.get(blocker)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      for (;;) {
        const member = stack.pop();
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      if (component.length > 1) {
        component.sort(compareIds);
        warnings.push(
          `blocker cycle among ${component.join(" → ")}; edges kept, nothing auto-broken`,
        );
      }
    }
  };

  for (const node of [...blockersOf.keys()].sort(compareIds)) {
    if (!index.has(node)) strongConnect(node);
  }
  return warnings;
};
