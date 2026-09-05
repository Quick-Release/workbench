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
