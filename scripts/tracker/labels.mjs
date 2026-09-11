import { readFile } from "node:fs/promises";

import { plainText, shorten } from "../services/shared.mjs";

// The canonical phase set the snapshot schema speaks (src/types.ts mirrors it
// for the browser side). A host's vocabulary file may only map these phases;
// anything else is dropped with a warning so records always decode.
export const CANONICAL_WORKFLOW_PHASES = [
  "grilling",
  "prototyping",
  "specced",
  "ticketed",
  "implementing",
  "reviewing",
  "shipped",
];

// ADR 0007: phase and kind encode as namespaced labels. This module is the
// label grammar for the tracker adapter; the workflow vocabulary's canonical
// home is docs/agents/workflow-labels.md, parsed in flow order, with this
// default standing in for host repos that do not carry the file.
export const DEFAULT_WORKFLOW_VOCABULARY = CANONICAL_WORKFLOW_PHASES.map((phase) => ({
  phase,
  label: `workflow:${phase}`,
}));

// docs/agents/triage-labels.md — the five canonical roles; absence is
// "unlabeled". Canonical order also breaks ties between accidental doubles.
export const TRIAGE_LABELS = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
];

export const WAYFINDER_KINDS = ["map", "research", "prototype", "grilling", "task"];

export const CATEGORY_LABELS = ["bug", "enhancement"];

const labelNames = (issue) =>
  (Array.isArray(issue?.labels) ? issue.labels : [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim());

export const workflowVocabularyFromMarkdown = (text) => {
  const vocabulary = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const row = line.match(/^\|\s*([a-z][a-z-]*)\s*\|\s*`workflow:([a-z][a-z-]*)`\s*\|/);
    if (!row) continue;
    const [, phase, name] = row;
    if (vocabulary.some((entry) => entry.label === `workflow:${name}`)) continue;
    vocabulary.push({ phase, label: `workflow:${name}` });
  }
  return vocabulary;
};

// Loads the vocabulary from its doc home, falling back to the built-in table
// with a warning into the sync warnings channel (never silently): the file is
// unreadable, parses to nothing, or declares phases outside the canonical set.
export const loadWorkflowVocabulary = async (path) => {
  if (!path) return { vocabulary: DEFAULT_WORKFLOW_VOCABULARY, warnings: [] };
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {
      vocabulary: DEFAULT_WORKFLOW_VOCABULARY,
      warnings: [
        `tracker: workflow vocabulary file ${path} unreadable; using the built-in vocabulary`,
      ],
    };
  }
  const parsed = workflowVocabularyFromMarkdown(text);
  if (parsed.length === 0)
    return {
      vocabulary: DEFAULT_WORKFLOW_VOCABULARY,
      warnings: [
        `tracker: workflow vocabulary file ${path} has no phase table; using the built-in vocabulary`,
      ],
    };
  const usable = parsed.filter((entry) => CANONICAL_WORKFLOW_PHASES.includes(entry.phase));
  const dropped = parsed
    .filter((entry) => !CANONICAL_WORKFLOW_PHASES.includes(entry.phase))
    .map((entry) => entry.label);
  return {
    vocabulary: usable.length > 0 ? usable : DEFAULT_WORKFLOW_VOCABULARY,
    warnings: dropped.map(
      (label) =>
        `tracker: workflow vocabulary declares ${label}, which is not a canonical phase; ignored`,
    ),
  };
};

export const phaseFromLabels = (labels, vocabulary = DEFAULT_WORKFLOW_VOCABULARY) => {
  const worn = labels.filter((label) => label.startsWith("workflow:"));
  const known = worn
    .map((label) => vocabulary.find((entry) => entry.label === label))
    .filter((entry) => entry && CANONICAL_WORKFLOW_PHASES.includes(entry.phase));
  if (worn.length === 0) return { phase: null };
  if (known.length === 0)
    return {
      phase: null,
      warning: `unknown workflow label ${worn.map((l) => `"${l}"`).join(", ")}; treated as pre-flow`,
    };
  const furthest = known.reduce(
    (best, entry) => (vocabulary.indexOf(entry) > vocabulary.indexOf(best) ? entry : best),
    known[0],
  );
  if (worn.length === 1 && known.length === 1) return { phase: furthest.phase };
  return {
    phase: furthest.phase,
    warning: `workflow labels ${worn.map((l) => `"${l}"`).join(", ")} resolve to the furthest-along phase "${furthest.phase}"`,
  };
};

const firstWithWarning = (labels, canonical, describe) => {
  const worn = canonical.filter((label) => labels.includes(label));
  if (worn.length === 0) return { value: null };
  if (worn.length === 1) return { value: worn[0] };
  return { value: worn[0], warning: describe(worn) };
};

export const triageStateFromLabels = (labels) => {
  const { value, warning } = firstWithWarning(
    labels,
    TRIAGE_LABELS,
    (worn) => `multiple triage labels ${worn.map((l) => `"${l}"`).join(", ")}; used "${worn[0]}"`,
  );
  return { triageState: value ?? "unlabeled", warning };
};

export const categoryFromLabels = (labels) =>
  firstWithWarning(
    labels,
    CATEGORY_LABELS,
    (worn) => `multiple category labels ${worn.map((l) => `"${l}"`).join(", ")}; used "${worn[0]}"`,
  );

export const kindFromLabels = (labels) => {
  const worn = labels
    .filter((label) => label.startsWith("wayfinder:"))
    .map((label) => label.slice("wayfinder:".length));
  const known = worn.filter((kind) => WAYFINDER_KINDS.includes(kind));
  if (worn.length === 0) return { kind: null };
  if (known.length === 0)
    return {
      kind: null,
      warning: `unknown wayfinder label ${worn.map((l) => `"wayfinder:${l}"`).join(", ")}; kind not set`,
    };
  const kind = WAYFINDER_KINDS.find((candidate) => known.includes(candidate));
  if (worn.length === 1) return { kind };
  return {
    kind,
    warning: `wayfinder labels ${worn.map((l) => `"wayfinder:${l}"`).join(", ")}; used "${kind}"`,
  };
};

export const deriveWorkItem = (issue, vocabulary = DEFAULT_WORKFLOW_VOCABULARY) => {
  const labels = labelNames(issue);
  const id = `GH-${issue.number}`;
  const withPrefix = (warning) => (warning ? [`${id}: ${warning}`] : []);
  const phase = phaseFromLabels(labels, vocabulary);
  const triage = triageStateFromLabels(labels);
  const category = categoryFromLabels(labels);
  const kind = kindFromLabels(labels);
  return {
    record: {
      id,
      title: plainText(issue.title) || `Issue ${issue.number}`,
      url: issue.html_url ?? "",
      state: issue.state === "closed" ? "closed" : "open",
      assignees: (Array.isArray(issue.assignees) ? issue.assignees : [])
        .map((assignee) => assignee?.login)
        .filter((login) => typeof login === "string" && login.trim().length > 0),
      phase: phase.phase,
      triageState: triage.triageState,
      deferred: labels.includes("deferred"),
      category: category.value,
      kind: kind.kind,
      summary: shorten(issue.body ?? ""),
      // GH-136: the source labels and timestamps ride so the shared client
      // policy (src/lib/client-priority.ts) derives classification, tier, and
      // gate decisions from what GitHub actually says — never a stored copy.
      labels,
      createdAt: issue.created_at ?? undefined,
      updatedAt: issue.updated_at ?? undefined,
      // Why GitHub says it closed — completed vs not_planned render honestly
      // in the client lens instead of every closure posing as a delivered fix.
      stateReason:
        issue.state_reason === "completed" || issue.state_reason === "not_planned"
          ? issue.state_reason
          : undefined,
    },
    warnings: [
      ...withPrefix(phase.warning),
      ...withPrefix(triage.warning),
      ...withPrefix(category.warning),
      ...withPrefix(kind.warning),
    ],
  };
};
