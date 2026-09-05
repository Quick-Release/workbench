// ADR 0009: decisions and artifacts collect at sync from exactly three
// decision sources — `adr` (docs/adr files), `resolution` (the closing
// resolution comment on a closed decision ticket), and `spec` (one bundle
// record per spec issue's Implementation-Decisions section, never parsed
// per bullet) — plus research notes as the only artifact. This module is the
// pure half: record builders, the declared-line grammar, and the two local
// file walks. Map sub-issue enumeration and comment reads stay in the
// tracker collector, which stitches these builders in.

const DECISION_STATUSES = ["proposed", "accepted", "deprecated", "superseded"];

const ADR_FILENAME = /^(\d{4})-[A-Za-z0-9][A-Za-z0-9-]*\.md$/;

// Declared lines follow the blocker-edge grammar's shape: a `Name:` line
// whose value is one reference, optionally bulleted and bolded.
const declaredLine = (text, name) => {
  const pattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.+)$`, "im");
  return (
    String(text ?? "")
      .match(pattern)?.[1]
      .trim() ?? null
  );
};

const workItemRefFrom = (value) => {
  const match = String(value ?? "").match(/^(?:#?(\d+)|GH-(\d+))$/i);
  return match ? `GH-${match[1] ?? match[2]}` : null;
};

const supersedesRefFrom = (value) => {
  const match = String(value ?? "").match(/^ADR-(\d{4})$/i);
  return match ? `ADR-${match[1]}` : null;
};

const titleFrom = (text) =>
  String(text ?? "")
    .match(/^#\s+(.+)$/m)?.[1]
    .trim() ?? "";

const decisionRecord = (overrides) => ({
  id: "",
  source: "adr",
  workItemId: null,
  title: "",
  statement: null,
  status: null,
  supersedes: null,
  decidedAt: null,
  sourceRef: "",
  ...overrides,
});

// `docs/adr/NNNN-slug.md`: H1 as title, `Status:` line (a missing or
// unparsable status loads with a warning — display data, not gate semantics),
// declared `Work item: GH-NN` linkage (nullable, warned when absent), and an
// optional `Supersedes: ADR-NNNN`.
export const adrDecisionFromText = ({ filename, text, sourceRef }) => {
  const warnings = [];
  const numberMatch = filename.match(ADR_FILENAME);
  const id = numberMatch ? `ADR-${numberMatch[1]}` : filename;

  const rawStatus = declaredLine(text, "Status");
  const status = rawStatus
    ? (DECISION_STATUSES.find((candidate) => candidate === rawStatus.trim().toLowerCase()) ?? null)
    : null;
  if (status === null)
    warnings.push(
      `${id}: ${rawStatus ? `unparsable status "${rawStatus}"` : "no Status line"}; record loads without one`,
    );

  const rawWorkItem = declaredLine(text, "Work item");
  const workItemId = rawWorkItem ? workItemRefFrom(rawWorkItem) : null;
  if (workItemId === null) warnings.push(`${id}: no Work item: GH-NN line; linkage left unset`);

  const rawSupersedes = declaredLine(text, "Supersedes");
  const supersedes = rawSupersedes ? supersedesRefFrom(rawSupersedes) : null;
  if (rawSupersedes !== null && supersedes === null)
    warnings.push(`${id}: Supersedes line does not declare ADR-NNNN; left unset`);

  return {
    record: decisionRecord({
      id,
      source: "adr",
      workItemId,
      title: titleFrom(text),
      status,
      supersedes,
      sourceRef,
    }),
    warnings,
  };
};

// The ADR walk: every top-level `NNNN-slug.md`, sorted by id, never a
// recursive sweep. A missing directory fails soft — `exists: false` so sync
// can report the convention it did not find.
export const collectAdrDecisions = async ({ directory, readdir, readFile }) => {
  const readDir = readdir ?? (await import("node:fs/promises")).readdir;
  const readText = readFile ?? (await import("node:fs/promises")).readFile;
  let names = [];
  let present = true;
  try {
    names = (await readDir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && ADR_FILENAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    present = false;
  }

  const decisions = [];
  const warnings = [];
  for (const name of names) {
    let text = "";
    try {
      text = await readText(joinPath(directory, name));
    } catch {
      warnings.push(`ADR-${name.match(ADR_FILENAME)?.[1] ?? name}: file unreadable; skipped`);
      continue;
    }
    const parsed = adrDecisionFromText({
      filename: name,
      text,
      sourceRef: joinPath("docs/adr", name),
    });
    decisions.push(parsed.record);
    warnings.push(...parsed.warnings);
  }
  return { decisions: sortDecisions(decisions), warnings, exists: present };
};

// `spec`: one bundle record per spec issue's Implementation-Decisions
// section — the section's presence declares it, one record regardless of how
// many bullets the section carries.
export const specDecisionFromIssue = (issue) => {
  const body = String(issue?.body ?? "");
  if (!/^##\s+implementation decisions\s*$/im.test(body)) return null;
  return decisionRecord({
    id: `GH-${issue.number}`,
    source: "spec",
    workItemId: `GH-${issue.number}`,
    title: issue.title ?? "",
    sourceRef: issue.html_url ?? "",
  });
};

// `resolution`: the closing resolution comment on a closed decision ticket —
// the last comment under this repo's resolve-then-close convention — carried
// in full, uncapped, with the comment timestamp as decidedAt.
export const resolutionDecisionFromIssue = ({ issue, comments }) => {
  const closing = comments?.length > 0 ? comments[comments.length - 1] : null;
  if (!closing) return null;
  return decisionRecord({
    id: `GH-${issue.number}`,
    source: "resolution",
    workItemId: `GH-${issue.number}`,
    title: issue.title ?? "",
    statement: String(closing.body ?? ""),
    decidedAt: closing.created_at ?? null,
    sourceRef: closing.html_url ?? "",
  });
};

const RESEARCH_FILENAME = /\.md$/i;

// `RN-<filename-slug>`: filename without its extension, lowercased, with
// runs of non-alphanumerics collapsed to dashes.
const researchSlug = (filename) =>
  filename
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Artifacts are research notes only: H1 as title, optional `Work item:` linkage
// that is silent when absent, path relative to the repo root.
export const artifactFromResearchFile = ({ filename, text, rootDirectory }) => {
  const relative = (path) => {
    const parts = path.split(/[\\/]/);
    const marker = parts.lastIndexOf("docs");
    return marker === -1 ? path : parts.slice(marker).join("/");
  };
  const rawWorkItem = declaredLine(text, "Work item");
  return {
    record: {
      id: `RN-${researchSlug(filename)}`,
      kind: "research-note",
      path: relative(joinPath(rootDirectory ?? "", "docs/research", filename)),
      title: titleFrom(text),
      workItemId: rawWorkItem ? workItemRefFrom(rawWorkItem) : null,
    },
    warnings: [],
  };
};

// The research-note walk: every top-level markdown file under docs/research,
// sorted by filename. Missing directory fails soft like the ADR walk.
export const collectResearchArtifacts = async ({ directory, rootDirectory, readdir, readFile }) => {
  const readDir = readdir ?? (await import("node:fs/promises")).readdir;
  const readText = readFile ?? (await import("node:fs/promises")).readFile;
  let names = [];
  let present = true;
  try {
    names = (await readDir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && RESEARCH_FILENAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    present = false;
  }

  const artifacts = [];
  for (const name of names) {
    let text = "";
    try {
      text = await readText(joinPath(directory, name));
    } catch {
      continue;
    }
    artifacts.push(artifactFromResearchFile({ filename: name, text, rootDirectory }).record);
  }
  return { artifacts, exists: present };
};

const numberSuffix = (id) => Number(id.slice(id.lastIndexOf("-") + 1)) || 0;

const namespace = (id) => id.slice(0, id.lastIndexOf("-"));

// A stable, total order for the snapshot array: records group by namespace
// first (ADR decisions, then tracker ids), numerically within each, and same
// id sorts by source so resolution and spec records for one work item keep a
// deterministic order.
export const sortDecisions = (records) =>
  [...records].sort(
    (left, right) =>
      namespace(left.id).localeCompare(namespace(right.id)) ||
      numberSuffix(left.id) - numberSuffix(right.id) ||
      left.source.localeCompare(right.source),
  );

// Path join without pulling node:path into the pure module's import graph —
// forward slashes are correct for every consumer of these repo-relative refs.
const joinPath = (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/");
