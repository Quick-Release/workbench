// The Clarification draft (spec #221, ticket #233, ADR 0017): the attempt's
// proposal as a typed, mutable document — behavior, scope, exclusions,
// acceptance criteria, labeled assumptions, evidence, and the issue body
// publication would write, shaped by the issue's task profile. Saving a
// draft is never publication approval; this module owns the document's
// shape and its completeness arithmetic, not the gates around it.
//
// Task profiles gate brief completeness: each profile names the minimum
// material an implementation-ready Issue brief carries (the task-brief
// research table), and every unmet minimum is a named gap. Gaps are
// completeness, not validity — an empty section saves fine and reads back
// as the gap it is, because a half-finished draft must stay saveable to be
// correctable. The unclassified profile is its own standing gap: the
// Developer classifies the work, and it is never silently a feature.
// Material assumptions are gaps too — minor uncertainty may stay visibly
// labeled, material assumptions cannot remain in an approved brief.
//
// Provenance is the claim-level honesty contract: every evidence item and
// assumption carries a bounded provenance kind — tracker (read from the
// issue and its planning records), research (approved documentation
// evidence), model (the runtime's proposal, never authority), or developer
// (the Developer's own input) — plus the source and locator it came from.
// A claim that cannot show where it came from is refused, the same posture
// the context packet's provenance gate takes one tier up.
//
// The issue body is derived, never stored twice: `publicationBodyFor`
// serializes the draft deterministically into exactly the bytes publication
// would write, and the visible diff renders from that same serialization —
// so what the Developer reads as the diff is what publication writes, by
// construction rather than by discipline.

export const DRAFT_ENVELOPE_VERSION = "clarification-draft/v1";

export const TASK_PROFILES = ["bug", "refactor", "feature-request", "unknown"];

export const PROVENANCE_KINDS = ["tracker", "research", "model", "developer"];

// The verdicts brief completeness can honestly carry — always members of
// the readiness vocabulary, never a fifth word of it.
export const BRIEF_COMPLETENESS_VERDICTS = ["ready", "needs-information"];

// Past this many lines on either side, the diff falls back to
// remove-all/add-all: never wrong about what publication writes, only
// honest that it is not minimal.
const MAX_DIFF_LINES = 2000;

const draftError = (code, message) => Object.assign(new Error(message), { code });

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

// The draft document's fields, defined once: the validator refuses both
// missing structure and fields the contract never declared.
const TEXT_FIELDS = [
  "behavior",
  "observation",
  "reproduction",
  "boundary",
  "scope",
  "dependencies",
  "performanceClaim",
  "performanceEvidence",
];
const LIST_FIELDS = ["exclusions", "acceptance"];
const PROVENANCE_FIELDS = ["kind", "source", "locator"];
const DRAFT_FIELDS = [
  "version",
  "profile",
  ...TEXT_FIELDS,
  ...LIST_FIELDS,
  "assumptions",
  "evidence",
];

// The draft document's shape gate. Shape only — emptiness is completeness
// and is measured by `briefGapsFor`, never refused here — except for the
// claims themselves: a claim with no content, no label, or no provenance is
// not a claim, and a draft carrying one is refused with every reason named.
export const validateClarificationDraft = (draft) => {
  if (!isPlainObject(draft))
    throw draftError("invalid_draft", "a Clarification draft is an object");
  const reasons = [];
  if (draft.version !== DRAFT_ENVELOPE_VERSION)
    reasons.push(`the draft's envelope must be ${DRAFT_ENVELOPE_VERSION}`);
  if (!TASK_PROFILES.includes(draft.profile))
    reasons.push(`the task profile must be one of: ${TASK_PROFILES.join(", ")}`);
  for (const field of TEXT_FIELDS)
    if (typeof draft[field] !== "string") reasons.push(`the draft's ${field} must be a string`);
  for (const field of LIST_FIELDS) {
    if (!Array.isArray(draft[field]) || draft[field].some((entry) => !isNonEmptyString(entry)))
      reasons.push(`the draft's ${field} must be a list of non-empty strings`);
  }
  if (!Array.isArray(draft.assumptions)) {
    reasons.push("the draft's assumptions must be a list");
  } else {
    draft.assumptions.forEach((assumption, index) => {
      if (!isPlainObject(assumption)) {
        reasons.push(`assumption ${index} is not an object`);
        return;
      }
      if (!isNonEmptyString(assumption.label)) reasons.push(`assumption ${index} carries no label`);
      if (!isNonEmptyString(assumption.text)) reasons.push(`assumption ${index} carries no text`);
      if (typeof assumption.material !== "boolean")
        reasons.push(`assumption ${index} must say whether it is material`);
      validateProvenance(assumption.provenance, `assumption ${index}`, reasons);
    });
  }
  if (!Array.isArray(draft.evidence)) {
    reasons.push("the draft's evidence must be a list");
  } else {
    draft.evidence.forEach((item, index) => {
      if (!isPlainObject(item)) {
        reasons.push(`evidence ${index} is not an object`);
        return;
      }
      if (!isNonEmptyString(item.claim)) reasons.push(`evidence ${index} carries no claim`);
      validateProvenance(item.provenance, `evidence ${index}`, reasons);
    });
  }
  for (const key of Object.keys(draft))
    if (!DRAFT_FIELDS.includes(key))
      reasons.push(`"${key}" is not a field of a Clarification draft`);
  if (reasons.length > 0)
    throw draftError("invalid_draft", `this is not a Clarification draft (${reasons.join("; ")})`);
  return draft;
};

const validateProvenance = (provenance, what, reasons) => {
  if (!isPlainObject(provenance)) {
    reasons.push(`${what} carries no provenance`);
    return;
  }
  if (!PROVENANCE_KINDS.includes(provenance.kind))
    reasons.push(`${what}'s provenance kind must be one of: ${PROVENANCE_KINDS.join(", ")}`);
  if (!isNonEmptyString(provenance.source)) reasons.push(`${what}'s provenance names no source`);
  if (!isNonEmptyString(provenance.locator)) reasons.push(`${what}'s provenance names no locator`);
  for (const key of Object.keys(provenance))
    if (!PROVENANCE_FIELDS.includes(key))
      reasons.push(`"${key}" is not a field of a claim's provenance`);
};

const hasContent = (value) => value.trim() !== "";

// The task profile's unmet minimums, each a named gap. The minimums are the
// task-brief research table's: what differs by profile is exactly what the
// table requires, and nothing else. An unclassified profile has no minimums
// to check — classification is the gap.
export const briefGapsFor = (draft) => {
  const valid = validateClarificationDraft(draft);
  if (valid.profile === "unknown")
    return [
      "the task profile is unclassified — the Developer classifies it; it is never silently a feature",
    ];
  const gaps = [];
  if (!hasContent(valid.scope)) gaps.push("no bounded scope is written");
  if (!valid.acceptance.some(hasContent))
    gaps.push("no observable acceptance criteria are written");
  if (valid.profile === "bug") {
    if (!hasContent(valid.behavior)) gaps.push("no expected behavior is written");
    if (!hasContent(valid.observation)) gaps.push("no actual behavior is written");
    if (!hasContent(valid.reproduction))
      gaps.push("neither a reproduction nor an explicit reproduction limit is written");
  }
  if (valid.profile === "refactor") {
    if (!hasContent(valid.behavior)) gaps.push("no behavior-preservation goal is written");
    if (!valid.exclusions.some(hasContent)) gaps.push("no exclusions are declared");
    if (hasContent(valid.performanceClaim) && !hasContent(valid.performanceEvidence))
      gaps.push("a performance claim is written without evidence for it");
  }
  if (valid.profile === "feature-request") {
    if (!hasContent(valid.behavior)) gaps.push("no intended behavior is written");
    if (!hasContent(valid.boundary)) gaps.push("no user/system boundary is written");
    if (!valid.exclusions.some(hasContent)) gaps.push("no exclusions are declared");
    if (!hasContent(valid.dependencies))
      gaps.push("no relevant dependencies or decisions are recorded");
  }
  for (const assumption of valid.assumptions)
    if (assumption.material)
      gaps.push(`the material assumption "${assumption.label}" needs the Developer's resolution`);
  return gaps;
};

// The brief-completeness verdict over one draft: ready exactly when no gap
// remains, needs-information otherwise — the two words the readiness
// vocabulary speaks, never a score.
export const briefCompletenessFor = (draft) => {
  const gaps = briefGapsFor(draft);
  return { verdict: gaps.length === 0 ? "ready" : "needs-information", gaps };
};

const listItems = (items) =>
  items
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => `- ${item}`);

// The exact bytes publication would write for this draft: every section in
// a fixed order, present only when it has content, assumptions labeled with
// their materiality, evidence carrying its provenance kind. The visible
// diff renders from this same serialization, so the display and the
// publication can never disagree about the body.
export const publicationBodyFor = (draft) => {
  const valid = validateClarificationDraft(draft);
  const parts = [];
  const section = (heading, body) => {
    const text = body.trim();
    if (text !== "") parts.push(`## ${heading}\n\n${text}`);
  };
  section("Behavior", valid.behavior);
  section("Actual behavior", valid.observation);
  section("Reproduction", valid.reproduction);
  section("User and system boundary", valid.boundary);
  section("Scope", valid.scope);
  section("Exclusions", listItems(valid.exclusions).join("\n"));
  section("Acceptance criteria", listItems(valid.acceptance).join("\n"));
  section("Dependencies and decisions", valid.dependencies);
  if (hasContent(valid.performanceClaim)) {
    const claim = valid.performanceClaim.trim();
    const evidence = valid.performanceEvidence.trim();
    section("Performance claims", evidence === "" ? claim : `${claim}\n\nEvidence: ${evidence}`);
  }
  section(
    "Assumptions",
    valid.assumptions
      .map(
        (assumption) =>
          `- [${assumption.label.trim()}]${assumption.material ? " (material)" : ""} ${assumption.text.trim()}`,
      )
      .join("\n"),
  );
  section(
    "Evidence",
    valid.evidence
      .map(
        (item) =>
          `- ${item.claim.trim()} (_${item.provenance.kind}_: ${item.provenance.source.trim()} ${item.provenance.locator.trim()})`,
      )
      .join("\n"),
  );
  return parts.join("\n\n");
};

const splitLines = (text) => (text === "" ? [] : text.split("\n"));

// The longest-common-subsequence table, filled from the ends so a forward
// walk reconstructs the diff in reading order.
const lcsTable = (a, b) => {
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  return table;
};

// The visible issue-body diff: the current body against the bytes
// publication would write, as an ordered line list a viewer can color.
// `unchanged` with zero counts is the honest "this draft writes exactly
// what is there" — never skipped, always rendered.
export const renderIssueBodyDiff = ({ before, after }) => {
  if (typeof before !== "string" || typeof after !== "string")
    throw draftError("invalid_request", "the issue-body diff renders two body strings");
  const a = splitLines(before);
  const b = splitLines(after);
  const lines = [];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    for (const text of a) lines.push({ kind: "removed", text });
    for (const text of b) lines.push({ kind: "added", text });
  } else {
    const table = lcsTable(a, b);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        lines.push({ kind: "context", text: a[i] });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        lines.push({ kind: "removed", text: a[i] });
        i += 1;
      } else {
        lines.push({ kind: "added", text: b[j] });
        j += 1;
      }
    }
    while (i < a.length) {
      lines.push({ kind: "removed", text: a[i] });
      i += 1;
    }
    while (j < b.length) {
      lines.push({ kind: "added", text: b[j] });
      j += 1;
    }
  }
  const added = lines.filter((line) => line.kind === "added").length;
  const removed = lines.filter((line) => line.kind === "removed").length;
  return { unchanged: added === 0 && removed === 0, added, removed, lines };
};
