// The namespaced work-item id grammar (ADR 0008): ids read
// `<namespace>-<number>` — `GH-41`, `ADR-0007` — and the namespace is a
// domain concept, so parsing lives here instead of hand-rolled slices at
// every use. The split sits on the last dash, so dash-bearing non-numeric
// ids (`RN-graph-rendering`) parse too: their namespace is everything
// before the last dash and their non-numeric suffix counts as number 0 —
// enough for the stable id order they participate in.

/** The id's namespace: everything before the last dash (`GH` in `GH-41`). */
export const workItemIdNamespace = (id: string): string => id.slice(0, id.lastIndexOf("-"));

/** The numeric suffix, 0 when the suffix is not a number (`41` in `GH-41`). */
export const workItemIdNumber = (id: string): number =>
  Number(id.slice(id.lastIndexOf("-") + 1)) || 0;

/** The bare number as text — the `?issue=NN` param and GitHub-url spelling. */
export const workItemIdNumberText = (id: string): string => id.slice(id.lastIndexOf("-") + 1);

/** The display label (`#41`) the views render beside the title. */
export const workItemIdLabel = (id: string): string => `#${workItemIdNumberText(id)}`;

/** Stable id order: namespace first, numerically within it. */
export const compareWorkItemIds = (left: string, right: string): number =>
  workItemIdNamespace(left).localeCompare(workItemIdNamespace(right)) ||
  workItemIdNumber(left) - workItemIdNumber(right);

/** Records sorted by their id's issue number ascending. */
export const byIssueNumber = <T extends { id: string }>(left: T, right: T): number =>
  workItemIdNumber(left.id) - workItemIdNumber(right.id);
