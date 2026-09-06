// The detail panel's search-param grammar (ticket #60): `?issue=NN` opens
// the shared panel for GH-NN, `?issue=new` opens the create form, and the
// param dropping off the URL closes it — browser-back is the close control.
export const issueParamFromSearch = (search: Record<string, unknown>): string | undefined =>
  typeof search.issue === "string" && (search.issue === "new" || /^\d+$/.test(search.issue))
    ? search.issue
    : undefined;

export const panelIdFor = (param: string | undefined): string | null => {
  if (!param) return null;
  return param === "new" ? "new" : `GH-${param}`;
};

// The blocker graph's params (ticket #61): `?effort` names the map — the
// panel's show-in-graph link spells it qualified (GH-41), bare numbers work
// too — and `?focus` deep-links a node as the jump target. `?expand` is the
// closed tier's toggle, spelled 1/0 like the other URL-param toggles.
const qualifiedId = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d+$/.test(value)
    ? `GH-${value}`
    : typeof value === "string" && /^GH-\d+$/.test(value)
      ? value
      : undefined;

export const effortParamFromSearch = (search: Record<string, unknown>): string | undefined =>
  qualifiedId(search.effort);

export const focusParamFromSearch = (search: Record<string, unknown>): string | undefined =>
  qualifiedId(search.focus);

export const expandParamFromSearch = (search: Record<string, unknown>): boolean =>
  search.expand === "1" || search.expand === "true";
