// This tab's own explicit acts on clarification runs (spec #221, ticket
// #237): the request ids it sent. The controller lease is the
// coordinator's, never a viewer's — so the only honest per-tab ownership
// fact is whether the newest recorded act was this tab's request or
// another viewer's. The set lives for the tab's lifetime, in memory only:
// a reload is a new viewer, which is exactly the "unheld — acquires on
// first action" case the display names.
const ownRequests = new Set<string>();

export const rememberOwnRequest = (requestId: string) => {
  ownRequests.add(requestId);
  return requestId;
};

export const ownRequestIds = (): ReadonlySet<string> => ownRequests;
