// The namespaced work-item id grammar (ADR 0008): ids read
// `<namespace>-<number>` — `GH-41`, `ADR-0007` — and the namespace is a
// domain concept, so parsing lives here instead of hand-rolled slices at
// every use. The split sits on the last dash, so dash-bearing non-numeric
// ids (`RN-graph-rendering`) parse too: their namespace is everything
// before the last dash and their non-numeric suffix counts as number 0 —
// enough for the stable id order they participate in.
//
// Plain ESM so the installed CLI's raw-Node scripts (the sync) can import
// it from node_modules, where Node refuses to type-strip TypeScript
// (GH-195); types live in the sibling .d.mts.

/** The id's namespace: everything before the last dash (`GH` in `GH-41`). */
export const workItemIdNamespace = (id) => id.slice(0, id.lastIndexOf("-"));

/** The numeric suffix, 0 when the suffix is not a number (`41` in `GH-41`). */
export const workItemIdNumber = (id) => Number(id.slice(id.lastIndexOf("-") + 1)) || 0;

/** The bare number as text — the `?issue=NN` param and GitHub-url spelling. */
export const workItemIdNumberText = (id) => id.slice(id.lastIndexOf("-") + 1);

/** The display label (`#41`) the views render beside the title. */
export const workItemIdLabel = (id) => `#${workItemIdNumberText(id)}`;

/** Stable id order: namespace first, numerically within it. */
export const compareWorkItemIds = (left, right) =>
  workItemIdNamespace(left).localeCompare(workItemIdNamespace(right)) ||
  workItemIdNumber(left) - workItemIdNumber(right);

/** Records sorted by their id's issue number ascending. */
export const byIssueNumber = (left, right) =>
  workItemIdNumber(left.id) - workItemIdNumber(right.id);
